/**
 * Shared module-level state for the current map viewport bounds, used by
 * `useDataPolling` to scope `/api/live-data/{fast,slow}` to the visible
 * area when the user has zoomed in.
 *
 * Issue #288: the backend now bbox-filters dense layers (vessels, aircraft,
 * gdelt events, fires, sigint, …) when all four bounds are supplied. Light
 * reference layers stay world-scale. Heavy collections aren't sent over the
 * wire for parts of the planet the operator isn't looking at, which cuts
 * the steady-state poll from ~27 MB to ~5 MB for a typical regional view.
 *
 * No bounds set → callers omit the params entirely → backend ships full
 * world data (byte-identical to pre-#288 behaviour). This keeps the cold
 * boot path (where no map is mounted yet) and the world-zoomed view
 * unchanged.
 */

export interface LiveDataBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

let _current: LiveDataBounds | null = null;

/** True when lng_span ≥ 300 OR lat_span ≥ 120. Backend treats these as
 *  world-scale and skips filtering — so the frontend doesn't bother sending
 *  bounds at all, which keeps the ETag cache shared across operators in the
 *  zoomed-out case. */
function isEffectivelyWorld(bounds: LiveDataBounds): boolean {
  const latSpan = Math.max(0, bounds.north - bounds.south);
  let lngSpan = bounds.east - bounds.west;
  if (lngSpan < 0) lngSpan += 360;
  return lngSpan >= 300 || latSpan >= 120;
}

/** Push the latest committed bounds. Called from `useViewportBounds`
 *  whenever the map's bounds change enough to matter. Pass `null` to
 *  fall back to world-scale fetching (e.g. on unmount). */
export function setLiveDataBounds(bounds: LiveDataBounds | null): void {
  if (bounds === null) {
    _current = null;
    return;
  }
  if (
    !Number.isFinite(bounds.south) ||
    !Number.isFinite(bounds.west) ||
    !Number.isFinite(bounds.north) ||
    !Number.isFinite(bounds.east)
  ) {
    _current = null;
    return;
  }
  if (isEffectivelyWorld(bounds)) {
    // World-zoomed → fetch globally, share the ETag cache across operators.
    _current = null;
    return;
  }
  _current = bounds;
}

/** Read the current bounds, or `null` if the caller should fetch the full
 *  world payload. Reader contract: must tolerate `null` and call without
 *  bbox params in that case. */
export function getLiveDataBounds(): LiveDataBounds | null {
  return _current;
}

/** Stable cache key for the active bbox-scoped fetch window (1° quantization,
 *  matching appendLiveDataBoundsParams / backend ETag). Returns null when
 *  world-scale fetching is active. */
export function liveDataBoundsKey(): string | null {
  const b = _current;
  if (!b) return null;
  const s = Math.floor(b.south);
  const w = Math.floor(b.west);
  const n = Math.ceil(b.north);
  const e = Math.ceil(b.east);
  return `${s},${w},${n},${e}`;
}

/** Append `s/w/n/e` query params to a URL when bounds are set, otherwise
 *  return the URL unchanged. Centralised so all live-data callers stay in
 *  sync about quantization and the world-scale skip rule. */
export function appendLiveDataBoundsParams(url: string): string {
  const b = _current;
  if (!b) return url;
  const sep = url.includes('?') ? '&' : '?';
  // Match backend ETag quantization (1° floor/ceil) so the client and
  // server agree on which bounds round to the same cache key.
  const s = Math.floor(b.south);
  const w = Math.floor(b.west);
  const n = Math.ceil(b.north);
  const e = Math.ceil(b.east);
  return `${url}${sep}s=${s}&w=${w}&n=${n}&e=${e}`;
}

// ─── The VISIBLE viewport ───────────────────────────────────────────────────
//
// `_current` above is the PRELOAD window: the view expanded to a 3,000-mile
// radius and coarsened (viewportPrivacy), so it barely moves when the operator
// zooms. Area-scoped feeds that must follow what is actually on screen (the
// civic layers: a 50 km circle when zoomed in, per-state when zoomed out) read
// this instead. It is never sent to the backend.

let _visible: LiveDataBounds | null = null;

export function setVisibleViewBounds(bounds: LiveDataBounds | null): void {
  if (
    !bounds ||
    ![bounds.south, bounds.west, bounds.north, bounds.east].every((n) => Number.isFinite(n))
  ) {
    _visible = null;
    return;
  }
  _visible = { ...bounds };
}

/** What is on screen now, or null before the map has reported a view. */
export function getVisibleViewBounds(): LiveDataBounds | null {
  return _visible;
}

function spanOf(b: LiveDataBounds): { lat: number; lng: number } {
  let lng = b.east - b.west;
  if (lng < 0) lng += 360;
  return { lat: Math.max(1e-6, Math.abs(b.north - b.south)), lng: Math.max(1e-6, lng) };
}

/**
 * Did the visible view change enough that area-scoped feeds should refetch?
 * Relative, not absolute: a zoom from the whole US to one city keeps the
 * preload window nearly identical, but here the span shrinks 50x.
 */
export function visibleViewChanged(a: LiveDataBounds | null, b: LiveDataBounds): boolean {
  if (!a) return true;
  const sa = spanOf(a);
  const sb = spanOf(b);
  const zoomRatio = Math.max(sa.lat / sb.lat, sb.lat / sa.lat);
  if (zoomRatio > 1.5) return true;
  const dLat = Math.abs((a.north + a.south) / 2 - (b.north + b.south) / 2);
  let dLng = Math.abs((a.west + sa.lng / 2) - (b.west + sb.lng / 2));
  if (dLng > 180) dLng = 360 - dLng;
  return dLat > sb.lat * 0.25 || dLng > sb.lng * 0.25;
}

/**
 * Approximate on-screen bounds for a camera target (web mercator: at zoom z a
 * 512-px tile spans 360/2^z degrees of longitude). Used to announce a fly-to
 * destination immediately, so area-scoped feeds do not wait on `moveend` —
 * which a headless or backgrounded renderer may never deliver.
 */
export function estimateViewBounds(
  lat: number,
  lng: number,
  zoom: number,
  widthPx = 1280,
  heightPx = 800,
): LiveDataBounds {
  const z = Number.isFinite(zoom) ? Math.max(0, Math.min(22, zoom)) : 8;
  const degPerPx = 360 / (512 * 2 ** z);
  const halfLng = Math.min(180, (widthPx / 2) * degPerPx);
  const halfLat = Math.min(85, (heightPx / 2) * degPerPx * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  return {
    south: Math.max(-90, lat - halfLat),
    north: Math.min(90, lat + halfLat),
    west: Math.max(-180, lng - halfLng),
    east: Math.min(180, lng + halfLng),
  };
}
