/**
 * AitherOS Digital Twin Town layer.
 *
 * A simulated town for the area in view: venues (cafes, halls, parks, ...) with
 * how many synthetic resident twins are there this hour and how many meetings
 * they are holding, plus the real local happenings the twins are reacting to.
 * Residents are simulated twins, never real people.
 *
 * Upstream: Genesis `/civic/layers/town`, reached the same way as every other
 * civic layer — through this app's server-side `/api/civic-proxy/*`, never from
 * the browser to the upstream directly.
 *
 * Response contract (FeatureCollection, `format=geojson`):
 *   venue     Point  { layer: "twin-town", kind, name, open, twins_here, meetings_hour, hour }
 *   happening Point  { layer: "twin-news", title, source, link, published_at }  (area centroid)
 *   foreign member   town: { id, name, county_fips, residents, synthetic: true, as_of, cache_age_s }
 * HTTP 202 {"status":"warming"}: the area is being prepared; retry with backoff.
 *
 * Everything here is pure (no React) so the hook, the map layer, the popups and
 * the tests share one definition of the URL, the sanitiser and the store.
 */
import type { LiveDataBounds } from '@/lib/liveDataViewport';
import { civicQueryFromBounds, civicQueryKey, type CivicQuery } from '@/lib/civicLayers';

export const TWIN_TOWN_LAYER_KEYS = ['twin_town', 'twin_town_news'] as const;
export type TwinTownLayerKey = (typeof TWIN_TOWN_LAYER_KEYS)[number];

/** Entity `type` the map click handler and popups key on. */
export const TWIN_ENTITY_TYPE = { venue: 'twin_venue', news: 'twin_news' } as const;

export const TWIN_MAX_VENUES = 500;
export const TWIN_MAX_NEWS = 20;
export const TWIN_SYNTHETIC_NOTE = 'Residents are simulated twins, not real people.';
export const TWIN_WARMING_MESSAGE = 'Twin town warming up for this area';
/** Upstream 429: this visitor's anonymous quota of new areas is spent for today. */
export const TWIN_QUOTA_MESSAGE = "Too many new areas today — try a place you've visited";

/** Warming retry: 5 s, 10 s, 20 s, then every 30 s; give up after 5 minutes. */
export const TWIN_WARMING_FIRST_DELAY_MS = 5000;
export const TWIN_WARMING_MAX_DELAY_MS = 30000;
export const TWIN_WARMING_GIVE_UP_MS = 5 * 60 * 1000;

const MAX_TEXT = 200;

// ─── Area ───────────────────────────────────────────────────────────────────

/** A county resolved by a civic lookup (state postal code + 3-digit county FIPS). */
export type TwinCounty = { state: string; county: string; lat: number; lng: number };

export type TwinTownArea =
  | { kind: 'county'; state: string; county: string }
  | { kind: 'circle'; query: CivicQuery };

let resolvedCounty: TwinCounty | null = null;

/** Called when a civic lookup resolves the county under a point. */
export function setResolvedTwinCounty(c: TwinCounty | null): void {
  if (c && (!/^[A-Z]{2}$/.test(c.state) || !/^\d{3}$/.test(c.county))) return;
  resolvedCounty = c;
}

export function getResolvedTwinCounty(): TwinCounty | null {
  return resolvedCounty;
}

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function inside(b: LiveDataBounds, lat: number, lng: number): boolean {
  if (lat < b.south || lat > b.north) return false;
  return b.west <= b.east ? lng >= b.west && lng <= b.east : lng >= b.west || lng <= b.east;
}

/**
 * The area the town is asked for: the resolved county when its lookup point is
 * on screen, else the same lat/lng circle (max 50 km) the civic point layers
 * send. A town is local, so a zoomed-out view never fans out state-wide.
 */
export function twinTownAreaFromBounds(
  bounds: LiveDataBounds | null | undefined,
  county: TwinCounty | null = resolvedCounty,
): TwinTownArea {
  if (
    county &&
    bounds &&
    [bounds.south, bounds.west, bounds.north, bounds.east].every(finite) &&
    inside(bounds, county.lat, county.lng)
  ) {
    return { kind: 'county', state: county.state, county: county.county };
  }
  return { kind: 'circle', query: civicQueryFromBounds(bounds) };
}

export function twinTownAreaKey(area: TwinTownArea): string {
  return area.kind === 'county' ? `k:${area.state}${area.county}` : `c:${civicQueryKey(area.query)}`;
}

export function twinTownUrl(area: TwinTownArea): string {
  const params =
    area.kind === 'county'
      ? new URLSearchParams({ state: area.state, county: area.county })
      : new URLSearchParams({
          lat: String(area.query.lat),
          lng: String(area.query.lng),
          radius_km: String(area.query.radius_km),
        });
  params.set('format', 'geojson');
  return `/api/civic-proxy/town?${params.toString()}`;
}

/** Delay before warming retry `attempt` (0-based): doubles from 5 s, capped at 30 s. */
export function twinWarmingDelayMs(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt));
  return Math.min(TWIN_WARMING_MAX_DELAY_MS, TWIN_WARMING_FIRST_DELAY_MS * 2 ** Math.min(n, 10));
}

/**
 * Delay before retry `attempt` after a 202 or a 503: the warming backoff, but
 * never sooner than the upstream's Retry-After (seconds), and never past the
 * give-up window.
 */
export function twinRetryDelayMs(attempt: number, retryAfter: string | null | undefined): number {
  const backoff = twinWarmingDelayMs(attempt);
  const s = retryAfter && /^\d{1,5}$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : 0;
  return Math.min(TWIN_WARMING_GIVE_UP_MS, Math.max(backoff, s * 1000));
}

// ─── Sanitising ─────────────────────────────────────────────────────────────

/**
 * Plain text only: drop tags, control characters and angle brackets, collapse
 * whitespace, cap length. React escapes on render too; this keeps markup out
 * of map labels (MapLibre text-field) and out of anything copied elsewhere.
 */
export function twinText(v: unknown, max = MAX_TEXT): string {
  if (typeof v !== 'string') return '';
  const s = v
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** http(s) URLs only; anything else (javascript:, data:, relative) becomes ''. */
export function twinLink(v: unknown): string {
  if (typeof v !== 'string' || v.length > 2048) return '';
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch {
    return '';
  }
}

function count(v: unknown): number {
  return finite(v) && v > 0 ? Math.floor(v) : 0;
}

function point(coords: unknown): [number, number] | null {
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const [lng, lat] = coords;
  if (!finite(lng) || !finite(lat)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return [lng, lat];
}

export type TwinTownMeta = {
  id: string;
  name: string;
  county_fips: string;
  residents: number;
  synthetic: boolean;
  as_of: string;
  cache_age_s: number;
};

export type TwinNewsItem = { title: string; source: string; link: string; published_at: string };

export type TwinTownData = {
  town: TwinTownMeta | null;
  venues: GeoJSON.FeatureCollection<GeoJSON.Point>;
  /** One clickable pin at the area centroid; its popup lists `news`. */
  newsPin: GeoJSON.FeatureCollection<GeoJSON.Point>;
  news: TwinNewsItem[];
};

function sanitizeTown(raw: unknown): TwinTownMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  return {
    id: twinText(t.id, 80),
    name: twinText(t.name, 80) || 'Twin town',
    county_fips: /^\d{3,5}$/.test(String(t.county_fips ?? '')) ? String(t.county_fips) : '',
    residents: count(t.residents),
    // The contract says synthetic:true; never let a payload claim otherwise.
    synthetic: true,
    as_of: twinText(t.as_of, 40),
    cache_age_s: count(t.cache_age_s),
  };
}

/** Keep well-formed Points, re-shape properties to the known set, cap counts. */
export function sanitizeTwinTown(
  raw: unknown,
  maxVenues = TWIN_MAX_VENUES,
  maxNews = TWIN_MAX_NEWS,
): TwinTownData | null {
  if (!raw || typeof raw !== 'object') return null;
  const fc = raw as { type?: unknown; features?: unknown; town?: unknown };
  if (fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) return null;
  const venues: GeoJSON.Feature<GeoJSON.Point>[] = [];
  const news: TwinNewsItem[] = [];
  let newsAt: [number, number] | null = null;
  for (const item of fc.features) {
    if (venues.length >= maxVenues && news.length >= maxNews) break;
    const f = item as { geometry?: { coordinates?: unknown }; properties?: unknown } | null;
    if (!f || typeof f !== 'object') continue;
    const props = (f.properties && typeof f.properties === 'object' ? f.properties : {}) as Record<string, unknown>;
    const at = point(f.geometry?.coordinates);
    if (!at) continue;
    if (props.layer === 'twin-town' && venues.length < maxVenues) {
      const twins = count(props.twins_here);
      const meetings = count(props.meetings_hour);
      venues.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: at },
        properties: {
          type: TWIN_ENTITY_TYPE.venue,
          id: `${TWIN_ENTITY_TYPE.venue}-${venues.length}`,
          lng: at[0],
          lat: at[1],
          name: twinText(props.name, 80) || 'Unnamed venue',
          kind: twinText(props.kind, 40),
          open: props.open === true,
          twins_here: twins,
          meetings_hour: meetings,
          hour: finite(props.hour) && props.hour >= 0 && props.hour <= 23 ? Math.floor(props.hour) : -1,
        },
      });
    } else if (props.layer === 'twin-news' && news.length < maxNews) {
      const title = twinText(props.title);
      if (!title) continue;
      news.push({
        title,
        source: twinText(props.source, 80),
        link: twinLink(props.link),
        published_at: twinText(props.published_at, 40),
      });
      newsAt = newsAt ?? at;
    }
  }
  const newsPin: GeoJSON.Feature<GeoJSON.Point>[] =
    newsAt && news.length
      ? [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: newsAt },
            properties: {
              type: TWIN_ENTITY_TYPE.news,
              id: `${TWIN_ENTITY_TYPE.news}-0`,
              lng: newsAt[0],
              lat: newsAt[1],
              name: `Town news (${news.length})`,
              count: news.length,
            },
          },
        ]
      : [];
  return {
    town: sanitizeTown(fc.town),
    venues: { type: 'FeatureCollection', features: venues },
    newsPin: { type: 'FeatureCollection', features: newsPin },
    news,
  };
}

/** Header chip text: "<name> · <residents> synthetic twins · as of <time>". */
export function twinTownChipText(town: TwinTownMeta): string {
  const when = twinAsOfLabel(town.as_of);
  return `${town.name} · ${town.residents.toLocaleString('en-US')} synthetic twins${when ? ` · as of ${when}` : ''}`;
}

/** "14:05" for an ISO timestamp, else the sanitised text as given. */
export function twinAsOfLabel(asOf: string): string {
  if (!asOf) return '';
  const d = new Date(asOf);
  if (Number.isNaN(d.getTime())) return asOf;
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

// ─── Status store (left-panel chip) ─────────────────────────────────────────

export const TWIN_TOWN_STATUS_EVENT = 'sb:twin-town-status';

export type TwinTownStatus =
  | { phase: 'off' }
  | { phase: 'loading' }
  | { phase: 'warming' }
  | { phase: 'ready'; town: TwinTownMeta | null }
  | { phase: 'unavailable'; message: string };

let status: TwinTownStatus = { phase: 'off' };

export function getTwinTownStatus(): TwinTownStatus {
  return status;
}

export function setTwinTownStatus(next: TwinTownStatus): void {
  status = next;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(TWIN_TOWN_STATUS_EVENT));
}
