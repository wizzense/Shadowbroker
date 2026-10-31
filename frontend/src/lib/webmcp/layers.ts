/**
 * Catalogue of queryable data layers: which store key holds the entities, a human
 * label, and which map toggles (ActiveLayers keys) render it. Keys mirror
 * `DashboardData` in `@/types/dashboard`; the store is the same object the map
 * renders, so tools answer about exactly what the operator sees.
 */
import type { LiveBounds } from './types';

export interface DataLayer {
  id: string;
  label: string;
  /** ActiveLayers keys that render this data (empty = always present / panel-only). */
  toggles: readonly string[];
}

export const DATA_LAYERS: readonly DataLayer[] = [
  { id: 'commercial_flights', label: 'Commercial flights', toggles: ['flights'] },
  { id: 'private_flights', label: 'Private / GA flights', toggles: ['private'] },
  { id: 'private_jets', label: 'Private jets', toggles: ['jets'] },
  { id: 'military_flights', label: 'Military flights', toggles: ['military'] },
  { id: 'tracked_flights', label: 'Tracked / VIP flights', toggles: ['tracked'] },
  { id: 'uavs', label: 'UAVs', toggles: ['military'] },
  {
    id: 'ships',
    label: 'Ships (AIS)',
    toggles: ['ships_military', 'ships_cargo', 'ships_civilian', 'ships_passenger', 'ships_tracked_yachts'],
  },
  { id: 'satellites', label: 'Satellites', toggles: ['satellites'] },
  { id: 'cctv', label: 'CCTV cameras', toggles: ['cctv'] },
  { id: 'trains', label: 'Trains', toggles: ['trains'] },
  { id: 'news', label: 'News / threat feed', toggles: [] },
  { id: 'liveuamap', label: 'LiveUAmap incidents', toggles: ['global_incidents'] },
  { id: 'gdelt', label: 'GDELT incidents', toggles: ['global_incidents'] },
  { id: 'earthquakes', label: 'Earthquakes', toggles: ['earthquakes'] },
  { id: 'gps_jamming', label: 'GPS jamming zones', toggles: ['gps_jamming'] },
  { id: 'internet_outages', label: 'Internet outages', toggles: ['internet_outages'] },
  { id: 'datacenters', label: 'Data centers', toggles: ['datacenters'] },
  { id: 'military_bases', label: 'Military bases', toggles: ['military_bases'] },
  { id: 'power_plants', label: 'Power plants', toggles: ['power_plants'] },
  { id: 'firms_fires', label: 'Fire hotspots (FIRMS)', toggles: ['firms'] },
  { id: 'sigint', label: 'SIGINT (Meshtastic / APRS)', toggles: ['sigint_meshtastic', 'sigint_aprs'] },
  { id: 'kiwisdr', label: 'KiwiSDR receivers', toggles: ['kiwisdr'] },
  { id: 'psk_reporter', label: 'PSK Reporter spots', toggles: ['psk_reporter'] },
  { id: 'satnogs_stations', label: 'SatNOGS stations', toggles: ['satnogs'] },
  { id: 'tinygs_satellites', label: 'TinyGS satellites', toggles: ['tinygs'] },
  { id: 'scanners', label: 'Radio scanners', toggles: ['scanners'] },
  { id: 'ukraine_alerts', label: 'Ukraine air-raid alerts', toggles: ['ukraine_alerts'] },
  { id: 'weather_alerts', label: 'Weather alerts', toggles: ['weather_alerts'] },
  { id: 'air_quality', label: 'Air quality stations', toggles: ['air_quality'] },
  { id: 'volcanoes', label: 'Volcanoes', toggles: ['volcanoes'] },
  { id: 'fishing_activity', label: 'Fishing activity', toggles: ['fishing_activity'] },
  { id: 'correlations', label: 'Cross-layer correlations', toggles: ['correlations'] },
  { id: 'uap_sightings', label: 'UAP sightings', toggles: ['uap_sightings'] },
  { id: 'wastewater', label: 'Wastewater pathogen sites', toggles: ['wastewater'] },
  { id: 'crowdthreat', label: 'CrowdThreat reports', toggles: ['crowdthreat'] },
  { id: 'sar_anomalies', label: 'SAR anomalies', toggles: ['sar'] },
  { id: 'airports', label: 'Airports', toggles: [] },
];

/** Friendly group names a model is likely to use. */
export const LAYER_GROUPS: Readonly<Record<string, readonly string[]>> = {
  flights: ['commercial_flights', 'private_flights', 'private_jets', 'military_flights', 'tracked_flights', 'uavs'],
  aircraft: ['commercial_flights', 'private_flights', 'private_jets', 'military_flights', 'tracked_flights', 'uavs'],
  vessels: ['ships'],
  incidents: ['liveuamap', 'gdelt', 'crowdthreat'],
  infrastructure: ['datacenters', 'power_plants', 'military_bases', 'airports'],
};

const BY_ID = new Map(DATA_LAYERS.map((l) => [l.id, l]));

export const LAYER_IDS: readonly string[] = DATA_LAYERS.map((l) => l.id);

/** Resolve a layer name or group to data-layer ids; unknown -> []. Absent -> all. */
export function resolveLayers(layer: unknown): string[] {
  if (layer === undefined || layer === null || layer === '' || layer === 'all') return [...LAYER_IDS];
  const key = String(layer).trim().toLowerCase();
  if (BY_ID.has(key)) return [key];
  if (LAYER_GROUPS[key]) return [...LAYER_GROUPS[key]];
  return [];
}

export function getLayer(id: string): DataLayer | undefined {
  return BY_ID.get(id);
}

export function layerItems(store: Readonly<Record<string, unknown>>, layerId: string): unknown[] {
  const value = store[layerId];
  return Array.isArray(value) ? value : [];
}

const ID_FIELDS = ['id', 'mmsi', 'icao24', 'hex', 'norad_id', 'callsign', 'registration', 'name', 'title'] as const;

/** Stable-ish identifier for an entity, or '' when it has none. */
export function entityId(item: unknown): string {
  if (!item || typeof item !== 'object') return '';
  const rec = item as Record<string, unknown>;
  for (const f of ID_FIELDS) {
    const v = rec[f];
    if ((typeof v === 'string' && v.trim()) || typeof v === 'number') return String(v).trim();
  }
  return '';
}

/** True when any identifier field equals `id` (case-insensitive). */
export function matchesId(item: unknown, id: string): boolean {
  if (!item || typeof item !== 'object') return false;
  const want = id.trim().toLowerCase();
  if (!want) return false;
  const rec = item as Record<string, unknown>;
  return ID_FIELDS.some((f) => {
    const v = rec[f];
    return (typeof v === 'string' || typeof v === 'number') && String(v).trim().toLowerCase() === want;
  });
}

export function entityLatLng(item: unknown): { lat: number; lng: number } | null {
  if (!item || typeof item !== 'object') return null;
  const rec = item as Record<string, unknown>;
  const lat = Number(rec.lat ?? rec.latitude);
  const lng = Number(rec.lng ?? rec.lon ?? rec.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    return { lat, lng };
  }
  if (Array.isArray(rec.coords) && rec.coords.length >= 2) {
    const [a, b] = rec.coords as number[];
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90) return { lat: a, lng: b };
  }
  return null;
}

/** Bounding-box test that handles boxes crossing the antimeridian (west > east). */
export function inBounds(point: { lat: number; lng: number }, b: LiveBounds): boolean {
  if (point.lat < b.south || point.lat > b.north) return false;
  if (b.west <= b.east) return point.lng >= b.west && point.lng <= b.east;
  return point.lng >= b.west || point.lng <= b.east;
}

/** Case-insensitive match of `query` against an entity's top-level string/number fields. */
export function matchesQuery(item: unknown, query: string): boolean {
  if (!item || typeof item !== 'object') return false;
  const q = query.trim().toLowerCase();
  if (!q) return false;
  for (const [key, v] of Object.entries(item as Record<string, unknown>)) {
    if (key.startsWith('_') || key === 'trail') continue;
    if (typeof v === 'string' && v.toLowerCase().includes(q)) return true;
    if (typeof v === 'number' && String(v) === q) return true;
  }
  return false;
}
