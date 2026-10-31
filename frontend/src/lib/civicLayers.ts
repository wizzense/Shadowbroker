/**
 * AitherOS Civic Atlas layers.
 *
 * Three layers come from AitherOS's own civic cache (Genesis
 * `routers/civic_layers.py`): license-plate readers (ALPR), data centers, and
 * federal construction spending. They are area-scoped by design — the upstream
 * API answers for a county, a state, or a lat/lng circle (max 50 km) — so the
 * board queries the circle the operator is looking at and refetches when the
 * viewport moves somewhere new.
 *
 * The browser never calls aitherium.com directly: `/api/civic-proxy/*` in this
 * app forwards the request server-side (no CORS, and the upstream anonymous
 * quota is charged once per cached area instead of once per viewer).
 */
import type { LiveDataBounds, } from '@/lib/liveDataViewport';

export const CIVIC_LAYER_KEYS = ['civic_alpr', 'civic_datacenters', 'civic_projects'] as const;
export type CivicLayerKey = (typeof CIVIC_LAYER_KEYS)[number];

export type CivicQuery = { lat: number; lng: number; radius_km: number };

export const CIVIC_MAX_RADIUS_KM = 50;
/** Washington, DC — only used before the map has committed a viewport. */
export const CIVIC_DEFAULT_QUERY: CivicQuery = { lat: 38.9072, lng: -77.0369, radius_km: CIVIC_MAX_RADIUS_KM };

export type CivicDatacenterProperties = {
  name?: string;
  operator?: string;
  status?: string;
  osm_url?: string;
};

export type CivicAlprProperties = {
  name?: string;
  make?: string;
  operator?: string;
  direction?: string;
  osm_url?: string;
};

export type CivicProjectRecord = {
  award_id?: string;
  recipient?: string;
  amount?: number;
  description?: string;
  agency?: string;
  start?: string;
  end?: string;
  url?: string;
  category?: string;
};

export type CivicProjectsAnswer = {
  layer?: string;
  available?: boolean;
  area?: { state?: string; county?: string; cd?: string; label?: string } | string;
  period?: { start?: string; end?: string };
  construction_contracts?: { total?: number; top?: CivicProjectRecord[] };
  infrastructure_grants?: { total?: number; top?: CivicProjectRecord[] };
  source?: { name?: string; url?: string };
};

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Half the viewport's diagonal, clamped to what the civic API accepts. */
export function civicQueryFromBounds(bounds: LiveDataBounds | null | undefined): CivicQuery {
  if (!bounds) return CIVIC_DEFAULT_QUERY;
  const { south, west, north, east } = bounds;
  if (![south, west, north, east].every(finite)) return CIVIC_DEFAULT_QUERY;
  const lat = (south + north) / 2;
  let lngSpan = east - west;
  if (lngSpan < 0) lngSpan += 360;
  const lng = (((west + east) / 2 + 540) % 360) - 180;
  const latSpan = Math.abs(north - south);
  // 111 km per degree of latitude; longitude shrinks with cos(lat).
  const heightKm = latSpan * 111;
  const widthKm = lngSpan * 111 * Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  const diagonalKm = Math.sqrt(heightKm * heightKm + widthKm * widthKm);
  const radius = Math.min(CIVIC_MAX_RADIUS_KM, Math.max(5, diagonalKm / 2));
  return {
    lat: Math.round(lat * 1000) / 1000,
    lng: Math.round(lng * 1000) / 1000,
    radius_km: Math.round(radius),
  };
}

/** Stable cache key for an area — panning a few hundred metres must not refetch. */
export function civicQueryKey(q: CivicQuery): string {
  return `${q.lat.toFixed(2)},${q.lng.toFixed(2)},${q.radius_km}`;
}

export function civicLayerUrl(layer: CivicLayerKey, q: CivicQuery): string {
  const path = layer === 'civic_alpr' ? 'alpr' : layer === 'civic_datacenters' ? 'datacenters' : 'projects';
  const params = new URLSearchParams({
    lat: String(q.lat),
    lng: String(q.lng),
    radius_km: String(q.radius_km),
  });
  if (layer !== 'civic_projects') params.set('format', 'geojson');
  if (layer === 'civic_datacenters') params.set('leads', '0');
  return `/api/civic-proxy/${path}?${params.toString()}`;
}

function pointFeature(
  coords: unknown,
  properties: Record<string, unknown>,
): GeoJSON.Feature<GeoJSON.Point> | null {
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const [lng, lat] = coords;
  if (!finite(lng) || !finite(lat)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties };
}

/** Keep only well-formed Points, cap the payload, and drop upstream-only fields. */
/** Entity `type` the map click handler and popups key on, per civic point layer. */
export const CIVIC_ENTITY_TYPE = {
  alpr: 'civic_alpr',
  datacenters: 'civic_datacenter',
  projects: 'civic_project',
} as const;

export function sanitizeCivicPoints(
  raw: unknown,
  limit = 20000,
  entityType: string = CIVIC_ENTITY_TYPE.alpr,
): GeoJSON.FeatureCollection<GeoJSON.Point> | null {
  if (!raw || typeof raw !== 'object') return null;
  const fc = raw as { type?: string; features?: unknown };
  if (fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) return null;
  const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
  for (const item of fc.features) {
    if (features.length >= limit) break;
    const f = item as { geometry?: { coordinates?: unknown }; properties?: Record<string, unknown> } | null;
    if (!f || typeof f !== 'object') continue;
    const props = f.properties && typeof f.properties === 'object' ? f.properties : {};
    const coords = f.geometry?.coordinates;
    const lng = Array.isArray(coords) ? coords[0] : undefined;
    const lat = Array.isArray(coords) ? coords[1] : undefined;
    const feature = pointFeature(coords, {
      // `type` + `id` make the point selectable by the map's click handler;
      // lat/lng let the popup anchor without re-reading the geometry.
      type: entityType,
      id: `${entityType}-${features.length}`,
      lat: finite(lat) ? lat : 0,
      lng: finite(lng) ? lng : 0,
      name: typeof props.name === 'string' ? props.name : '',
      operator: typeof props.operator === 'string' ? props.operator : '',
      status: typeof props.status === 'string' ? props.status : '',
      make: typeof props.make === 'string' ? props.make : '',
      direction: typeof props.direction === 'string' ? props.direction : '',
      osm_url: typeof props.osm_url === 'string' ? props.osm_url : '',
    });
    if (feature) features.push(feature);
  }
  return { type: 'FeatureCollection', features };
}

function areaLabel(answer: CivicProjectsAnswer): string {
  const area = answer?.area;
  if (typeof area === 'string') return area;
  if (area && typeof area === 'object') {
    return area.label || area.county || area.state || '';
  }
  return '';
}

export function civicProjectsTotal(answer: CivicProjectsAnswer | null | undefined): number {
  const contracts = answer?.construction_contracts?.total;
  const grants = answer?.infrastructure_grants?.total;
  return (finite(contracts) ? contracts : 0) + (finite(grants) ? grants : 0);
}

/**
 * USAspending reports spending by PLACE OF PERFORMANCE, never per-contract
 * coordinates — so the layer is one anchor pin for the queried area carrying
 * the dollar total and the top awards, not invented per-contract points.
 */
export function buildCivicProjectsGeoJSON(
  answer: CivicProjectsAnswer | null,
  q: CivicQuery,
): GeoJSON.FeatureCollection<GeoJSON.Point> | null {
  if (!answer || answer.available === false) return null;
  const top = answer.construction_contracts?.top ?? [];
  const grants = answer.infrastructure_grants?.top ?? [];
  const total = civicProjectsTotal(answer);
  if (!top.length && !grants.length) return null;
  const records = [...top, ...grants].slice(0, 10);
  const label = areaLabel(answer) || `${q.lat.toFixed(2)}, ${q.lng.toFixed(2)}`;
  const feature = pointFeature([q.lng, q.lat], {
    type: CIVIC_ENTITY_TYPE.projects,
    id: `${CIVIC_ENTITY_TYPE.projects}-${civicQueryKey(q)}`,
    lat: q.lat,
    lng: q.lng,
    name: `Federal $${Math.round(total).toLocaleString('en-US')} · ${label}`,
    area: label,
    total,
    contracts_total: answer.construction_contracts?.total ?? 0,
    grants_total: answer.infrastructure_grants?.total ?? 0,
    period: `${answer.period?.start ?? ''}..${answer.period?.end ?? ''}`,
    count: records.length,
    awards: records.map((r) => ({
      recipient: r.recipient ?? '',
      amount: r.amount ?? 0,
      description: (r.description ?? '').slice(0, 160),
      agency: r.agency ?? '',
      url: r.url ?? '',
    })),
  });
  return { type: 'FeatureCollection', features: feature ? [feature] : [] };
}
