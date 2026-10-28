"""Feed Ingester — background daemon that refreshes feed-backed pin layers.

Layers with a non-empty `feed_url` are polled at their `feed_interval`
(seconds, minimum 60). The feed is expected to return either:

  1. GeoJSON FeatureCollection — features are converted to pins. Point
     features become pins; Polygon, MultiPolygon, LineString and
     MultiLineString features become pins that carry their shape (drawn as an
     outline/fill); the pin sits at the feed's own lat/lng if given, else at
     the centre of the shape's bounding box.
  2. JSON array of pin objects — used directly

Each refresh atomically replaces the layer's pins with the new data.

Feed URLs are fetched through services.ssrf_guard: http(s) only, and every hop
must resolve to a public address. SHADOWBROKER_FEED_ALLOW_HOSTS (comma-separated
hostnames, IPs or CIDRs) exempts a LAN feed server from the private-address
block; cloud-metadata addresses stay refused.
"""

import json
import logging
import math
import os
import threading
import time
from typing import Any

import requests

from services.network_utils import outbound_user_agent
from services.ssrf_guard import parse_allowlist, safe_get

logger = logging.getLogger(__name__)


def _feed_ingester_user_agent() -> str:
    # Round 7a: per-install attribution for operator-curated feed URLs.
    return outbound_user_agent("feed-ingester")

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

_running = False
_thread: threading.Thread | None = None
_CHECK_INTERVAL = 30  # seconds between scanning for layers that need refresh
_last_fetched: dict[str, float] = {}  # layer_id → last fetch timestamp
_FETCH_TIMEOUT = 20  # seconds
_MAX_FEED_BYTES = 8 * 1024 * 1024  # a feed body larger than this is refused
_MAX_REDIRECTS = 3

# Shape budgets: a feature over the per-feature cap is dropped (never truncated,
# which would draw a wrong outline), and so is one that would overrun what is
# left of the per-layer budget.
SHAPE_TYPES = frozenset({"Polygon", "MultiPolygon", "LineString", "MultiLineString"})
_MAX_SHAPE_VERTICES = 5_000
_MAX_LAYER_SHAPE_VERTICES = 50_000

# ---------------------------------------------------------------------------
# GeoJSON → pin conversion
# ---------------------------------------------------------------------------


def _position(pos: Any) -> list[float] | None:
    """[lng, lat] from a GeoJSON position, or None if it is not a valid lon/lat."""
    if not isinstance(pos, (list, tuple)) or len(pos) < 2:
        return None
    try:
        lng, lat = float(pos[0]), float(pos[1])
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(lng) and math.isfinite(lat)):
        return None
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None
    return [lng, lat]


def _line(coords: Any, min_points: int) -> list[list[float]] | None:
    if not isinstance(coords, (list, tuple)) or len(coords) < min_points:
        return None
    out = []
    for pos in coords:
        p = _position(pos)
        if p is None:
            return None
        out.append(p)
    return out


def _lines(coords: Any, min_points: int) -> list[list[list[float]]] | None:
    if not isinstance(coords, (list, tuple)) or not coords:
        return None
    out = []
    for c in coords:
        line = _line(c, min_points)
        if line is None:
            return None
        out.append(line)
    return out


def _normalize_shape(geom: dict) -> tuple[dict[str, Any], int] | None:
    """Validate a Polygon/MultiPolygon/LineString/MultiLineString geometry.

    Returns (geometry with 2-D positions only, vertex count), or None when the
    geometry is malformed or out of range.
    """
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if gtype == "LineString":
        norm = _line(coords, 2)
    elif gtype == "MultiLineString":
        norm = _lines(coords, 2)
    elif gtype == "Polygon":
        norm = _lines(coords, 4)
    elif gtype == "MultiPolygon":
        if not isinstance(coords, (list, tuple)) or not coords:
            return None
        polys = [_lines(poly, 4) for poly in coords]
        norm = None if any(p is None for p in polys) else polys
    else:
        return None
    if norm is None:
        return None
    return {"type": gtype, "coordinates": norm}, _count_vertices(norm)


def _count_vertices(coords: Any) -> int:
    if coords and isinstance(coords[0], (int, float)):
        return 1
    return sum(_count_vertices(c) for c in coords)


def _iter_positions(coords: Any):
    if coords and isinstance(coords[0], (int, float)):
        yield coords
        return
    for c in coords:
        yield from _iter_positions(c)


def _label_point(geometry: dict[str, Any], props: dict) -> tuple[float, float]:
    """(lat, lng) for a shape's pin: the feed's own lat/lng if given, else its bbox centre."""
    given = _position([props.get("lng", props.get("lon")), props.get("lat")])
    if given is not None:
        return given[1], given[0]
    lngs, lats = zip(*_iter_positions(geometry["coordinates"]))
    return (min(lats) + max(lats)) / 2, (min(lngs) + max(lngs)) / 2


def _geojson_features_to_pins(features: list[dict]) -> list[dict[str, Any]]:
    """Convert GeoJSON Feature objects to pin dicts (points, and shapes with a label point)."""
    pins: list[dict[str, Any]] = []
    shape_budget = _MAX_LAYER_SHAPE_VERTICES
    dropped_shapes = 0
    for feat in features:
        if not isinstance(feat, dict):
            continue
        geom = feat.get("geometry") or {}
        props = feat.get("properties") or {}
        if not isinstance(geom, dict) or not isinstance(props, dict):
            continue

        shape: dict[str, Any] | None = None
        if geom.get("type") in SHAPE_TYPES:
            normalized = _normalize_shape(geom)
            if normalized is None:
                continue
            shape, vertices = normalized
            if vertices > _MAX_SHAPE_VERTICES or vertices > shape_budget:
                dropped_shapes += 1
                continue
            shape_budget -= vertices
            lat, lng = _label_point(shape, props)
        else:
            # Extract coordinates
            coords = geom.get("coordinates")
            if geom.get("type") != "Point" or not coords or len(coords) < 2:
                continue

            lng, lat = float(coords[0]), float(coords[1])
            if not (-90 <= lat <= 90 and -180 <= lng <= 180):
                continue

        pin: dict[str, Any] = {
            "lat": lat,
            "lng": lng,
            "label": str(props.get("label", props.get("name", props.get("title", ""))))[:200],
            "category": str(props.get("category", "custom"))[:50],
            "color": str(props.get("color", ""))[:20],
            "description": str(props.get("description", props.get("summary", "")))[:2000],
            "source": "feed",
            "source_url": str(props.get("source_url", props.get("url", props.get("link", ""))))[:500],
            "confidence": float(props.get("confidence", 1.0)),
        }

        # Entity attachment if present
        entity_type = props.get("entity_type", "")
        entity_id = props.get("entity_id", "")
        if entity_type and entity_id:
            pin["entity_attachment"] = {
                "entity_type": str(entity_type),
                "entity_id": str(entity_id),
                "entity_label": str(props.get("entity_label", "")),
            }

        if shape is not None:
            pin["geometry"] = shape

        pins.append(pin)
    if dropped_shapes:
        logger.warning(
            "Feed dropped %d shape(s) over the vertex caps (%d per shape, %d per layer)",
            dropped_shapes, _MAX_SHAPE_VERTICES, _MAX_LAYER_SHAPE_VERTICES,
        )
    return pins


def _parse_feed_response(data: Any) -> list[dict[str, Any]]:
    """Parse a feed response into a list of pin dicts."""
    if isinstance(data, dict):
        # GeoJSON FeatureCollection
        if data.get("type") == "FeatureCollection" and isinstance(data.get("features"), list):
            return _geojson_features_to_pins(data["features"])
        # Single Feature
        if data.get("type") == "Feature":
            return _geojson_features_to_pins([data])
        # Wrapped response like {"ok": true, "data": [...]}
        inner = data.get("data") or data.get("results") or data.get("pins") or data.get("items")
        if isinstance(inner, list):
            return _normalize_pin_list(inner)

    if isinstance(data, list):
        # Check if first item looks like a GeoJSON Feature
        if data and isinstance(data[0], dict) and data[0].get("type") == "Feature":
            return _geojson_features_to_pins(data)
        return _normalize_pin_list(data)

    return []


def _normalize_pin_list(items: list) -> list[dict[str, Any]]:
    """Normalize a list of raw pin objects, ensuring lat/lng are present."""
    pins: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        lat = item.get("lat") or item.get("latitude")
        lng = item.get("lng") or item.get("lon") or item.get("longitude")
        if lat is None or lng is None:
            continue
        try:
            lat, lng = float(lat), float(lng)
        except (ValueError, TypeError):
            continue
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            continue

        pin: dict[str, Any] = {
            "lat": lat,
            "lng": lng,
            "label": str(item.get("label", item.get("name", item.get("title", ""))))[:200],
            "category": str(item.get("category", "custom"))[:50],
            "color": str(item.get("color", ""))[:20],
            "description": str(item.get("description", item.get("summary", "")))[:2000],
            "source": "feed",
            "source_url": str(item.get("source_url", item.get("url", item.get("link", ""))))[:500],
            "confidence": float(item.get("confidence", 1.0)),
        }

        entity_type = item.get("entity_type", "")
        entity_id = item.get("entity_id", "")
        if entity_type and entity_id:
            pin["entity_attachment"] = {
                "entity_type": str(entity_type),
                "entity_id": str(entity_id),
                "entity_label": str(item.get("entity_label", "")),
            }

        pins.append(pin)
    return pins


# ---------------------------------------------------------------------------
# Fetch a single layer
# ---------------------------------------------------------------------------


class FeedRefused(ValueError):
    """The feed URL or its response may not be used (SSRF guard, size cap)."""


def _feed_allowlist():
    return parse_allowlist(os.environ.get("SHADOWBROKER_FEED_ALLOW_HOSTS", ""))


def _fetch_feed_json(feed_url: str) -> Any:
    """GET *feed_url* through the SSRF guard and parse at most _MAX_FEED_BYTES of JSON."""
    try:
        resp = safe_get(
            feed_url,
            timeout=_FETCH_TIMEOUT,
            headers={"User-Agent": _feed_ingester_user_agent()},
            max_redirects=_MAX_REDIRECTS,
            allow=_feed_allowlist(),
            stream=True,
        )
    except ValueError as e:  # requests' InvalidURL is a ValueError too
        raise FeedRefused(str(e)) from None
    with resp:
        resp.raise_for_status()
        body = bytearray()
        for chunk in resp.iter_content(chunk_size=64 * 1024):
            body.extend(chunk)
            if len(body) > _MAX_FEED_BYTES:
                raise FeedRefused(f"feed body exceeds {_MAX_FEED_BYTES} bytes")
    return json.loads(bytes(body))


def _fetch_layer_feed(layer: dict[str, Any]) -> None:
    """Fetch a feed URL and replace the layer's pins."""
    layer_id = layer["id"]
    feed_url = layer["feed_url"]
    layer_name = layer.get("name", layer_id)

    try:
        data = _fetch_feed_json(feed_url)
    except FeedRefused as e:
        logger.warning("Feed refused for layer '%s' (%s): %s", layer_name, feed_url, e)
        return
    except requests.RequestException as e:
        logger.warning("Feed fetch failed for layer '%s' (%s): %s", layer_name, feed_url, e)
        return
    except (ValueError, TypeError) as e:
        logger.warning("Feed parse failed for layer '%s' (%s): %s", layer_name, feed_url, e)
        return

    pins = _parse_feed_response(data)

    from services.ai_pin_store import replace_layer_pins, update_layer
    count = replace_layer_pins(layer_id, pins)

    # Update layer metadata with last_fetched timestamp
    update_layer(layer_id, feed_last_fetched=time.time())

    _last_fetched[layer_id] = time.time()
    logger.info("Feed refresh for layer '%s': %d pins from %s", layer_name, count, feed_url)


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


def _ingest_loop() -> None:
    """Daemon loop: scan for feed layers and refresh those that are due."""
    while _running:
        try:
            from services.ai_pin_store import get_feed_layers

            layers = get_feed_layers()
            now = time.time()

            for layer in layers:
                layer_id = layer["id"]
                interval = max(60, layer.get("feed_interval", 300))
                last = _last_fetched.get(layer_id, 0)

                if now - last >= interval:
                    try:
                        _fetch_layer_feed(layer)
                    except Exception as e:
                        logger.warning("Feed ingestion error for layer %s: %s",
                                       layer.get("name", layer_id), e)

        except Exception as e:
            logger.error("Feed ingester loop error: %s", e)

        # Sleep in short increments so we can stop cleanly
        for _ in range(int(_CHECK_INTERVAL)):
            if not _running:
                break
            time.sleep(1)


# ---------------------------------------------------------------------------
# Start / stop
# ---------------------------------------------------------------------------


def start_feed_ingester() -> None:
    """Start the feed ingester daemon thread."""
    global _running, _thread
    if _thread and _thread.is_alive():
        return
    _running = True
    _thread = threading.Thread(target=_ingest_loop, daemon=True, name="feed-ingester")
    _thread.start()
    logger.info("Feed ingester daemon started (check interval=%ds)", _CHECK_INTERVAL)


def stop_feed_ingester() -> None:
    """Stop the feed ingester daemon."""
    global _running
    _running = False
