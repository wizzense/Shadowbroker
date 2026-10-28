"""Feed layers keep Polygon / MultiPolygon / LineString / MultiLineString features.

A shape becomes a pin whose lat/lng is its label point and which carries the
shape; /api/ai/pins/geojson sends the shape only when asked (shapes=true), so
existing consumers keep receiving Points only.
"""

import pytest

from services import ai_pin_store, feed_ingester
from services.feed_ingester import _MAX_SHAPE_VERTICES, _parse_feed_response

SQUARE = [[[-84.6, 39.0], [-84.4, 39.0], [-84.4, 39.2], [-84.6, 39.2], [-84.6, 39.0]]]


def _feature(geometry, **props):
    return {"type": "Feature", "geometry": geometry, "properties": props}


def _fc(*features):
    return {"type": "FeatureCollection", "features": list(features)}


@pytest.fixture()
def isolated_store(monkeypatch):
    """Run against an empty in-memory pin store; never write pin_layers.json."""
    monkeypatch.setattr(ai_pin_store, "_save_to_disk", lambda: None)
    saved_layers, saved_pins = list(ai_pin_store._layers), list(ai_pin_store._pins)
    ai_pin_store._layers[:] = []
    ai_pin_store._pins[:] = []
    yield ai_pin_store
    ai_pin_store._layers[:] = saved_layers
    ai_pin_store._pins[:] = saved_pins


def test_points_are_unchanged():
    pins = _parse_feed_response(_fc(_feature({"type": "Point", "coordinates": [-84.5, 39.1]}, name="HQ")))
    assert len(pins) == 1
    assert (pins[0]["lat"], pins[0]["lng"], pins[0]["label"]) == (39.1, -84.5, "HQ")
    assert "geometry" not in pins[0]


@pytest.mark.parametrize(
    "geometry",
    [
        {"type": "Polygon", "coordinates": SQUARE},
        {"type": "MultiPolygon", "coordinates": [SQUARE, [[[1, 1], [2, 1], [2, 2], [1, 1]]]]},
        {"type": "LineString", "coordinates": [[-84.6, 39.0], [-84.4, 39.2]]},
        {"type": "MultiLineString", "coordinates": [[[-84.6, 39.0], [-84.4, 39.2]], [[0, 0], [1, 1]]]},
    ],
)
def test_shapes_are_kept_with_their_geometry(geometry):
    pins = _parse_feed_response(_fc(_feature(geometry, name="District 1", color="#ff0000")))
    assert len(pins) == 1
    assert pins[0]["geometry"]["type"] == geometry["type"]
    assert pins[0]["geometry"]["coordinates"] == geometry["coordinates"]
    assert pins[0]["label"] == "District 1" and pins[0]["color"] == "#ff0000"


def test_shape_label_point_is_bbox_centre_unless_the_feed_gives_one():
    centre = _parse_feed_response(_fc(_feature({"type": "Polygon", "coordinates": SQUARE})))[0]
    assert centre["lat"] == pytest.approx(39.1) and centre["lng"] == pytest.approx(-84.5)
    given = _parse_feed_response(_fc(_feature({"type": "Polygon", "coordinates": SQUARE}, lat=39.05, lng=-84.55)))[0]
    assert (given["lat"], given["lng"]) == (39.05, -84.55)


def test_third_dimension_is_dropped():
    pins = _parse_feed_response(_fc(_feature({"type": "LineString", "coordinates": [[1, 2, 300], [3, 4, 400]]})))
    assert pins[0]["geometry"]["coordinates"] == [[1.0, 2.0], [3.0, 4.0]]


@pytest.mark.parametrize(
    "geometry",
    [
        {"type": "Polygon", "coordinates": [[[0, 0], [1, 1], [0, 0]]]},  # ring under 4 positions
        {"type": "Polygon", "coordinates": [[[0, 0], [1, 1], [2, 2], [0, 95]]]},  # latitude out of range
        {"type": "LineString", "coordinates": [[0, 0]]},
        {"type": "LineString", "coordinates": [[0, 0], ["x", 1]]},
        {"type": "MultiPolygon", "coordinates": []},
        {"type": "GeometryCollection", "geometries": []},
        {"type": "Polygon", "coordinates": "not a list"},
    ],
)
def test_malformed_shapes_are_dropped(geometry):
    assert _parse_feed_response(_fc(_feature(geometry))) == []


def test_vertex_caps_drop_whole_shapes_never_truncate(monkeypatch):
    big = [[[i / 10_000, 0.0] for i in range(_MAX_SHAPE_VERTICES)] + [[0.0, 0.0]]]
    pins = _parse_feed_response(_fc(_feature({"type": "Polygon", "coordinates": big})))
    assert pins == []

    monkeypatch.setattr(feed_ingester, "_MAX_LAYER_SHAPE_VERTICES", 10)
    pins = _parse_feed_response(_fc(
        _feature({"type": "Polygon", "coordinates": SQUARE}, name="a"),  # 5 vertices
        _feature({"type": "Polygon", "coordinates": SQUARE}, name="b"),  # 5 more: budget spent
        _feature({"type": "Polygon", "coordinates": SQUARE}, name="c"),  # over budget: dropped
        _feature({"type": "Point", "coordinates": [1, 1]}, name="p"),  # points are not budgeted
    ))
    assert [p["label"] for p in pins] == ["a", "b", "p"]


def test_store_keeps_shape_and_uses_layer_colour(isolated_store):
    layer = isolated_store.create_layer("Districts", color="#123456", feed_url="https://feeds.example/d.geojson")
    pins = _parse_feed_response(_fc(
        _feature({"type": "Polygon", "coordinates": SQUARE}, name="no colour"),
        _feature({"type": "Polygon", "coordinates": SQUARE}, name="own colour", color="#abcdef"),
        _feature({"type": "Point", "coordinates": [-84.5, 39.1]}, name="point", category="news"),
    ))
    assert isolated_store.replace_layer_pins(layer["id"], pins) == 3

    by_label = {p["label"]: p for p in isolated_store._pins}
    assert by_label["no colour"]["color"] == "#123456"
    assert by_label["own colour"]["color"] == "#abcdef"
    assert by_label["point"]["color"] == isolated_store.PIN_COLORS["news"]  # points: unchanged rule
    assert by_label["no colour"]["geometry"]["type"] == "Polygon"

    # The list API stays light; the single-pin read still has the shape.
    listed = isolated_store.get_pins(layer_id=layer["id"])
    assert all("geometry" not in p for p in listed)
    assert isolated_store.get_pin(by_label["no colour"]["id"])["geometry"]["type"] == "Polygon"


def test_geojson_sends_shapes_only_when_asked(isolated_store):
    layer = isolated_store.create_layer("Districts", feed_url="https://feeds.example/d.geojson")
    isolated_store.replace_layer_pins(layer["id"], _parse_feed_response(_fc(
        _feature({"type": "Polygon", "coordinates": SQUARE}, name="D1"),
        _feature({"type": "Point", "coordinates": [-84.5, 39.1]}, name="office"),
    )))

    plain = isolated_store.pins_as_geojson()
    assert [f["geometry"]["type"] for f in plain["features"]] == ["Point", "Point"]

    rich = isolated_store.pins_as_geojson(include_shapes=True)
    kinds = [(f["geometry"]["type"], f["properties"].get("kind")) for f in rich["features"]]
    assert kinds == [("Point", None), ("Point", None), ("Polygon", "shape")]
    shape = rich["features"][-1]
    assert shape["properties"]["label"] == "D1" and shape["properties"]["layer_id"] == layer["id"]


def test_hidden_layer_hides_its_shapes(isolated_store):
    layer = isolated_store.create_layer("Districts", feed_url="https://feeds.example/d.geojson")
    isolated_store.replace_layer_pins(layer["id"], _parse_feed_response(_fc(
        _feature({"type": "Polygon", "coordinates": SQUARE}, name="D1"))))
    isolated_store.update_layer(layer["id"], visible=False)
    assert isolated_store.pins_as_geojson(include_shapes=True)["features"] == []


def test_geojson_route_passes_the_shapes_flag(client, isolated_store):
    layer = isolated_store.create_layer("Districts", feed_url="https://feeds.example/d.geojson")
    isolated_store.replace_layer_pins(layer["id"], _parse_feed_response(_fc(
        _feature({"type": "Polygon", "coordinates": SQUARE}, name="D1"))))

    plain = client.get("/api/ai/pins/geojson")
    assert plain.status_code == 200
    assert [f["geometry"]["type"] for f in plain.json()["features"]] == ["Point"]

    rich = client.get("/api/ai/pins/geojson?shapes=true")
    assert rich.status_code == 200
    assert [f["geometry"]["type"] for f in rich.json()["features"]] == ["Point", "Polygon"]


def test_ingester_fetches_through_the_guard(monkeypatch, isolated_store):
    layer = isolated_store.create_layer("Feed", feed_url="http://169.254.169.254/latest/meta-data/")
    with pytest.raises(feed_ingester.FeedRefused, match="metadata"):
        feed_ingester._fetch_feed_json(layer["feed_url"])
    # The refresh logs and keeps the layer as it was; nothing is fetched or replaced.
    feed_ingester._fetch_layer_feed(layer)
    assert isolated_store._pins == []


def test_oversized_feed_body_is_refused(monkeypatch):
    class _Resp:
        status_code = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def raise_for_status(self):
            return None

        def iter_content(self, chunk_size):
            for _ in range(3):
                yield b"x" * chunk_size

    monkeypatch.setattr(feed_ingester, "safe_get", lambda *a, **kw: _Resp())
    monkeypatch.setattr(feed_ingester, "_MAX_FEED_BYTES", 100_000)
    with pytest.raises(feed_ingester.FeedRefused, match="exceeds"):
        feed_ingester._fetch_feed_json("https://feeds.example/huge.json")


def test_allowlist_env_reaches_the_guard(monkeypatch):
    calls = {}

    def fake_safe_get(url, **kw):
        calls.update(kw)
        raise ValueError("stop here")

    monkeypatch.setattr(feed_ingester, "safe_get", fake_safe_get)
    monkeypatch.setenv("SHADOWBROKER_FEED_ALLOW_HOSTS", "feeds.lan")
    with pytest.raises(feed_ingester.FeedRefused):
        feed_ingester._fetch_feed_json("http://feeds.lan/f.geojson")
    assert calls["allow"].hosts == frozenset({"feeds.lan"})
    assert calls["stream"] is True
