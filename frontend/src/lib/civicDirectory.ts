/**
 * AitherOS Civic Atlas — elections, elected officials, local governments and
 * district boundaries.
 *
 * Upstream (Genesis `routers/civic.py`, logic in `lib/civic/*`):
 *   GET /civic/lookup?lat=&lng=            districts + officials + how-to-vote
 *   GET /civic/how-to-vote/{STATE}         official per-state voting links (NASS)
 *   GET /civic/geojson/{layer}?state=XX    TIGERweb boundaries, simplified
 *   GET /civic/units?state=&county=&kind=  Census of Governments 2022 directory
 *   GET /civic/elections?state=&district=  upcoming elections (FEC)
 *
 * Everything here is pure (no React, no next/server) so the proxy route, the
 * hooks, the panel and the tests share ONE definition of what is allowed and
 * how a response is shaped.
 */

// ─── Proxy allowlist ────────────────────────────────────────────────────────

/** Point layers served by Genesis `routers/civic_layers.py` under /civic/layers. */
export const CIVIC_POINT_LAYERS = ['alpr', 'datacenters', 'projects'] as const;
const POINT_LAYER_QUERY_KEYS = new Set(['lat', 'lng', 'radius_km', 'state', 'county', 'cd', 'format', 'leads']);

/** `lib/civic/boundaries.py` LAYERS, verbatim. */
export const CIVIC_BOUNDARY_LAYERS = [
  'congressional_district',
  'state_senate_district',
  'state_house_district',
  'county',
  'place',
  'school_district',
  'school_district_elementary',
  'school_district_secondary',
] as const;
export type CivicBoundaryLayer = (typeof CIVIC_BOUNDARY_LAYERS)[number];

/** `lib/civic/units.py` KINDS, verbatim. */
export const CIVIC_UNIT_KINDS = ['county', 'municipality', 'township', 'school_district'] as const;
export type CivicUnitKind = (typeof CIVIC_UNIT_KINDS)[number];

/** `lib/civic/officials.py` FIPS_TO_POSTAL values: the codes Genesis accepts. */
export const CIVIC_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM',
  'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA',
  'WV', 'WI', 'WY', 'AS', 'GU', 'MP', 'PR', 'VI',
]);

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export type CivicRouteKind = 'layer' | 'lookup' | 'how_to_vote' | 'geojson' | 'units' | 'elections';

export type CivicProxyRoute = {
  kind: CivicRouteKind;
  /** Path below CIVIC_API_BASE, starting with '/'. Built only from allowlisted parts. */
  upstreamPath: string;
  /** Rebuilt query string: only validated keys, canonical order. */
  query: string;
  /** How long a 200 is served from the proxy cache without asking upstream. */
  ttlMs: number;
  /** Upstream timeout. A cold boundary layer is a TIGERweb fetch on the far side. */
  timeoutMs: number;
};

export type CivicProxyRejection = { status: 404 | 422; error: string; message: string };

export type CivicProxyResolution = { ok: true; route: CivicProxyRoute } | ({ ok: false } & CivicProxyRejection);

function reject(status: 404 | 422, error: string, message: string): CivicProxyResolution {
  return { ok: false, status, error, message };
}

function stateParam(raw: string | null | undefined): string | null {
  const st = (raw || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(st) && CIVIC_STATE_CODES.has(st) ? st : null;
}

function coordParam(raw: string | null, min: number, max: number): number | null {
  if (raw === null || raw.length > 24 || !/^-?\d{1,3}(\.\d+)?$/.test(raw.trim())) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/**
 * Decide whether `/api/civic-proxy/<segments>?<params>` may be forwarded, and to
 * what. Anything not explicitly allowed is refused — this is not an open proxy:
 * the upstream path is assembled from constants and validated tokens only, and
 * unknown query keys are dropped rather than echoed.
 */
export function resolveCivicProxyRequest(segments: string[], params: URLSearchParams): CivicProxyResolution {
  const [head, second, ...rest] = segments;
  const notFound = () => reject(404, 'not_found', `Unknown civic route: ${segments.join('/').slice(0, 80)}`);
  if (!head || rest.length > 0) return notFound();

  // Legacy point layers: /api/civic-proxy/<layer>
  if ((CIVIC_POINT_LAYERS as readonly string[]).includes(head)) {
    if (second !== undefined) return notFound();
    const search = new URLSearchParams();
    for (const [key, value] of params.entries()) {
      if (POINT_LAYER_QUERY_KEYS.has(key) && value.length <= 32) search.set(key, value);
    }
    if (!search.has('lat') && !search.has('lng') && !search.has('state') && !search.has('county')) {
      return reject(422, 'area_required', 'Give lat/lng or a state/county.');
    }
    return {
      ok: true,
      route: {
        kind: 'layer',
        upstreamPath: `/layers/${head}`,
        query: search.toString(),
        ttlMs: 15 * MINUTE,
        // A cold state-wide projects answer is a USAspending query upstream
        // (measured >20 s for IN; Genesis allows 45 s).
        timeoutMs: head === 'projects' ? 50000 : 20000,
      },
    };
  }

  if (head === 'lookup') {
    if (second !== undefined) return notFound();
    // Address lookups are deliberately NOT proxied: an address would become a
    // cache key on this server. A map point is enough for "who represents here".
    const lat = coordParam(params.get('lat'), -90, 90);
    const lng = coordParam(params.get('lng'), -180, 180);
    if (lat === null || lng === null) return reject(422, 'point_required', 'Give lat and lng.');
    // ~110 m: keeps district edges honest while letting nearby clicks share a cache entry.
    const q = new URLSearchParams({ lat: lat.toFixed(3), lng: lng.toFixed(3) });
    return { ok: true, route: { kind: 'lookup', upstreamPath: '/lookup', query: q.toString(), ttlMs: 6 * HOUR, timeoutMs: 45000 } };
  }

  if (head === 'how-to-vote') {
    const st = stateParam(second);
    if (!st) return reject(422, 'state_required', 'Use a two-letter state code, e.g. OH.');
    return { ok: true, route: { kind: 'how_to_vote', upstreamPath: `/how-to-vote/${st}`, query: '', ttlMs: 24 * HOUR, timeoutMs: 20000 } };
  }

  if (head === 'geojson') {
    if (!second || !(CIVIC_BOUNDARY_LAYERS as readonly string[]).includes(second)) return notFound();
    const st = stateParam(params.get('state'));
    if (!st) return reject(422, 'state_required', 'Use a two-letter state code, e.g. OH.');
    return {
      ok: true,
      route: { kind: 'geojson', upstreamPath: `/geojson/${second}`, query: `state=${st}`, ttlMs: 24 * HOUR, timeoutMs: 120000 },
    };
  }

  if (head === 'units') {
    if (second !== undefined) return notFound();
    const st = stateParam(params.get('state'));
    if (!st) return reject(422, 'state_required', 'Use a two-letter state code, e.g. OH.');
    const q = new URLSearchParams({ state: st });
    const county = params.get('county');
    if (county) {
      if (!/^\d{3}$/.test(county)) return reject(422, 'bad_county', 'county is a three-digit county FIPS code, e.g. 061.');
      q.set('county', county);
    }
    const kind = params.get('kind');
    if (kind) {
      if (!(CIVIC_UNIT_KINDS as readonly string[]).includes(kind)) {
        return reject(422, 'bad_kind', `kind is one of: ${CIVIC_UNIT_KINDS.join(', ')}.`);
      }
      q.set('kind', kind);
    }
    return { ok: true, route: { kind: 'units', upstreamPath: '/units', query: q.toString(), ttlMs: 24 * HOUR, timeoutMs: 20000 } };
  }

  if (head === 'elections') {
    if (second !== undefined) return notFound();
    const st = stateParam(params.get('state'));
    if (!st) return reject(422, 'state_required', 'Use a two-letter state code, e.g. OH.');
    const q = new URLSearchParams({ state: st });
    const district = params.get('district');
    if (district) {
      if (!/^\d{1,2}$/.test(district)) return reject(422, 'bad_district', 'district is a congressional district number, e.g. 1.');
      q.set('district', String(Number(district)));
    }
    return { ok: true, route: { kind: 'elections', upstreamPath: '/elections', query: q.toString(), ttlMs: 1 * HOUR, timeoutMs: 20000 } };
  }

  return notFound();
}

// ─── Client URL builders ────────────────────────────────────────────────────

const PROXY = '/api/civic-proxy';

export function civicLookupUrl(lat: number, lng: number): string {
  return `${PROXY}/lookup?lat=${lat.toFixed(3)}&lng=${lng.toFixed(3)}`;
}

export function civicBoundaryUrl(layer: CivicBoundaryLayer, state: string): string {
  return `${PROXY}/geojson/${layer}?state=${encodeURIComponent(state)}`;
}

export function civicUnitsUrl(state: string, county?: string): string {
  const q = new URLSearchParams({ state });
  if (county) q.set('county', county);
  return `${PROXY}/units?${q.toString()}`;
}

export function civicElectionsUrl(state: string, district?: string): string {
  const q = new URLSearchParams({ state });
  if (district && /^\d{1,2}$/.test(district)) q.set('district', String(Number(district)));
  return `${PROXY}/elections?${q.toString()}`;
}

// ─── Response types (lib/civic/*) ───────────────────────────────────────────

export type CivicJurisdiction = {
  kind: string;
  geoid: string;
  name: string;
  state_fips?: string;
  district?: string;
  census_layer?: string;
  source_url?: string;
  license?: string;
};

export type CivicOfficial = {
  id?: string;
  name: string;
  office: string;
  level: 'federal' | 'state' | 'local' | string;
  kind?: string;
  state?: string;
  district?: string;
  jurisdiction?: string | null;
  party?: string;
  term_end?: string;
  phone?: string;
  email?: string;
  url?: string;
  source_url?: string;
  dataset?: string;
  license?: string;
  retrieved_at?: string;
};

export type CivicVacancy = { office: string; district?: string; note?: string; source_url?: string };

export type CivicVotingAction = { action: string; label: string; url: string; status: string; note?: string };

export type CivicHowToVote = {
  state: string;
  actions: CivicVotingAction[];
  source_url?: string;
  publisher?: string;
  retrieved_at?: string;
  notice?: string;
};

export type CivicLookupAnswer = {
  matched: boolean;
  message?: string;
  point?: { lat: number; lng: number } | null;
  state?: string;
  jurisdictions?: CivicJurisdiction[];
  officials?: CivicOfficial[];
  vacancies?: CivicVacancy[];
  officials_retrieved_at?: string;
  officials_stale?: boolean;
  how_to_vote?: CivicHowToVote | null;
  coverage_note?: string;
  how_to_vote_everywhere?: string;
};

export type CivicElection = {
  id?: string;
  level?: string;
  state?: string;
  office?: string;
  district?: string | null;
  date: string;
  type?: string;
  notes?: string;
  source_url?: string;
};

export type CivicElectionsAnswer = {
  state: string;
  district?: string;
  loaded: boolean;
  elections: CivicElection[];
  retrieved_at?: string;
  stale?: boolean;
  sources?: string[];
  coverage_note?: string;
  notice?: string;
};

export type CivicUnit = {
  id: string;
  kind: CivicUnitKind | string;
  name: string;
  county_fips?: string;
  county_area?: string;
  contact_title?: string;
  office_address?: string;
  website?: string;
  population?: number;
  source_url?: string;
  source_vintage?: string;
};

export type CivicUnitsAnswer = {
  state: string;
  loaded: boolean;
  units: CivicUnit[];
  count: number;
  source_url?: string;
  source_page?: string;
  source_vintage?: string;
  license?: string;
  retrieved_at?: string;
};

// ─── Grouping: Federal / State / County / City / School board ───────────────

export const CIVIC_GROUP_ORDER = ['federal', 'state', 'county', 'city', 'school', 'local'] as const;
export type CivicGroupKey = (typeof CIVIC_GROUP_ORDER)[number];

export const CIVIC_GROUP_LABEL: Record<CivicGroupKey, string> = {
  federal: 'Federal',
  state: 'State',
  county: 'County',
  city: 'City / Town',
  school: 'School board',
  local: 'Other local',
};

const JURISDICTION_GROUP: Record<string, CivicGroupKey> = {
  congressional_district: 'federal',
  state: 'state',
  state_senate_district: 'state',
  state_house_district: 'state',
  county: 'county',
  place: 'city',
  county_subdivision: 'city',
  school_district: 'school',
  school_district_elementary: 'school',
  school_district_secondary: 'school',
};

const UNIT_GROUP: Record<string, CivicGroupKey> = {
  county: 'county',
  municipality: 'city',
  township: 'city',
  school_district: 'school',
};

/** Which bucket an official belongs in. Local officials are split by their OCD jurisdiction id. */
export function officialGroup(o: Pick<CivicOfficial, 'level' | 'jurisdiction' | 'office' | 'kind'>): CivicGroupKey {
  if (o.level === 'federal') return 'federal';
  if (o.level === 'state') return 'state';
  const juris = (o.jurisdiction || '').toLowerCase();
  const office = `${o.office || ''} ${o.kind || ''}`.toLowerCase();
  if (/school/.test(juris) || /school|board of education/.test(office)) return 'school';
  if (/\/county:|\/parish:|\/borough:/.test(juris) || /county|sheriff/.test(office)) return 'county';
  if (/\/(place|municipality|city|town|township|village):/.test(juris) || /mayor|council/.test(office)) return 'city';
  return 'local';
}

const NAME_ABBREV: Record<string, string> = {
  SCH: 'SCHOOL', SCHS: 'SCHOOLS', DIST: 'DISTRICT', ELEM: 'ELEMENTARY', CONS: 'CONSOLIDATED',
  TWP: 'TOWNSHIP', CO: 'COUNTY', CNTY: 'COUNTY', COMM: 'COMMUNITY', JT: 'JOINT', IND: 'INDEPENDENT',
  REG: 'REGIONAL', UN: 'UNION', VLG: 'VILLAGE', MT: 'MOUNT', ST: 'SAINT',
};
const NAME_DROP = new Set([
  'THE', 'OF', 'SCHOOL', 'SCHOOLS', 'DISTRICT', 'PUBLIC', 'GOVERNMENT', 'CDP', 'COUNTY', 'CITY',
  'VILLAGE', 'TOWN', 'TOWNSHIP', 'BOROUGH', 'MUNICIPALITY',
]);

/** Comparable token key for a Census jurisdiction name or a Census-of-Governments unit name. */
export function civicNameKey(name: string): string {
  const tokens = (name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => NAME_ABBREV[t] ?? t)
    .filter((t) => !NAME_DROP.has(t));
  return Array.from(new Set(tokens)).sort().join(' ');
}

/**
 * The directory rows (2022 Census of Governments) that correspond to the
 * jurisdictions a lookup returned: the county government, the city/township,
 * the school district. Matched on the county FIPS plus a normalised name, never
 * on a substring, so a row is only shown when it is that place's government.
 */
export function matchUnitsToJurisdictions(units: CivicUnit[], jurisdictions: CivicJurisdiction[]): CivicUnit[] {
  const countyJ = jurisdictions.find((j) => j.kind === 'county');
  const countyFips = countyJ?.geoid?.slice(2, 5) || '';
  const wanted = new Map<string, Set<string>>();
  for (const j of jurisdictions) {
    const group = JURISDICTION_GROUP[j.kind];
    if (group !== 'city' && group !== 'school') continue;
    const key = civicNameKey(j.name);
    if (!key) continue;
    if (!wanted.has(group)) wanted.set(group, new Set());
    wanted.get(group)!.add(key);
  }
  const out: CivicUnit[] = [];
  const seen = new Set<string>();
  for (const u of units) {
    if (countyFips && u.county_fips && u.county_fips !== countyFips) continue;
    const group = UNIT_GROUP[u.kind];
    if (!group || seen.has(u.id)) continue;
    const hit = group === 'county' ? !!countyJ : !!wanted.get(group)?.has(civicNameKey(u.name));
    if (hit) {
      seen.add(u.id);
      out.push(u);
    }
  }
  return out;
}

export type CivicGroup = {
  key: CivicGroupKey;
  label: string;
  jurisdictions: CivicJurisdiction[];
  officials: CivicOfficial[];
  vacancies: CivicVacancy[];
  units: CivicUnit[];
};

function vacancyGroup(v: CivicVacancy): CivicGroupKey {
  return /^U\.S\./.test(v.office) ? 'federal' : 'state';
}

/** Lookup answer (+ optional directory units) → ordered, non-empty groups. */
export function groupCivicLookup(answer: CivicLookupAnswer | null | undefined, units: CivicUnit[] = []): CivicGroup[] {
  if (!answer || !answer.matched) return [];
  const groups = new Map<CivicGroupKey, CivicGroup>(
    CIVIC_GROUP_ORDER.map((key) => [key, { key, label: CIVIC_GROUP_LABEL[key], jurisdictions: [], officials: [], vacancies: [], units: [] }]),
  );
  const juris = answer.jurisdictions ?? [];
  for (const j of juris) {
    const key = JURISDICTION_GROUP[j.kind];
    if (key) groups.get(key)!.jurisdictions.push(j);
  }
  for (const o of answer.officials ?? []) groups.get(officialGroup(o))!.officials.push(o);
  for (const v of answer.vacancies ?? []) groups.get(vacancyGroup(v))!.vacancies.push(v);
  for (const u of matchUnitsToJurisdictions(units, juris)) {
    const key = UNIT_GROUP[u.kind];
    if (key) groups.get(key)!.units.push(u);
  }
  return CIVIC_GROUP_ORDER.map((k) => groups.get(k)!).filter(
    (g) => g.jurisdictions.length || g.officials.length || g.vacancies.length || g.units.length,
  );
}

/** The congressional district number a lookup resolved to ("01" → "1"), or ''. */
export function lookupCongressionalDistrict(answer: CivicLookupAnswer | null | undefined): string {
  const cd = (answer?.jurisdictions ?? []).find((j) => j.kind === 'congressional_district');
  const raw = (cd?.district || '').trim();
  return /^\d{1,2}$/.test(raw) ? String(Number(raw)) : '';
}

/** Three-digit county FIPS from the lookup's county GEOID ("39061" → "061"), or ''. */
export function lookupCountyFips(answer: CivicLookupAnswer | null | undefined): string {
  const c = (answer?.jurisdictions ?? []).find((j) => j.kind === 'county');
  const fips = (c?.geoid || '').slice(2, 5);
  return /^\d{3}$/.test(fips) ? fips : '';
}

// ─── Which state is in view ─────────────────────────────────────────────────

/** [west, south, east, north] per state — coarse envelopes, used only to pick which state's lines to load. */
const STATE_BBOX: Record<string, [number, number, number, number]> = {
  AL: [-88.47, 30.22, -84.89, 35.01], AK: [-179.15, 51.21, -129.98, 71.39], AZ: [-114.82, 31.33, -109.04, 37.0],
  AR: [-94.62, 33.0, -89.64, 36.5], CA: [-124.41, 32.53, -114.13, 42.01], CO: [-109.06, 36.99, -102.04, 41.0],
  CT: [-73.73, 40.98, -71.79, 42.05], DE: [-75.79, 38.45, -75.05, 39.84], DC: [-77.12, 38.79, -76.91, 38.99],
  FL: [-87.63, 24.52, -80.03, 31.0], GA: [-85.61, 30.36, -80.84, 35.0], HI: [-160.24, 18.91, -154.81, 22.24],
  ID: [-117.24, 41.99, -111.04, 49.0], IL: [-91.51, 36.97, -87.5, 42.51], IN: [-88.1, 37.77, -84.78, 41.76],
  IA: [-96.64, 40.38, -90.14, 43.5], KS: [-102.05, 36.99, -94.59, 40.0], KY: [-89.57, 36.5, -81.96, 39.15],
  LA: [-94.04, 28.93, -88.82, 33.02], ME: [-71.08, 43.06, -66.95, 47.46], MD: [-79.49, 37.91, -75.05, 39.72],
  MA: [-73.51, 41.24, -69.93, 42.89], MI: [-90.42, 41.7, -82.41, 48.31], MN: [-97.24, 43.5, -89.49, 49.38],
  MS: [-91.66, 30.17, -88.1, 35.0], MO: [-95.77, 35.99, -89.1, 40.61], MT: [-116.05, 44.36, -104.04, 49.0],
  NE: [-104.05, 40.0, -95.31, 43.0], NV: [-120.01, 35.0, -114.04, 42.0], NH: [-72.56, 42.7, -70.61, 45.31],
  NJ: [-75.56, 38.93, -73.89, 41.36], NM: [-109.05, 31.33, -103.0, 37.0], NY: [-79.76, 40.5, -71.86, 45.02],
  NC: [-84.32, 33.84, -75.46, 36.59], ND: [-104.05, 45.94, -96.55, 49.0], OH: [-84.82, 38.4, -80.52, 41.98],
  OK: [-103.0, 33.62, -94.43, 37.0], OR: [-124.57, 41.99, -116.46, 46.29], PA: [-80.52, 39.72, -74.69, 42.27],
  RI: [-71.86, 41.15, -71.12, 42.02], SC: [-83.35, 32.03, -78.54, 35.22], SD: [-104.06, 42.48, -96.44, 45.95],
  TN: [-90.31, 34.98, -81.65, 36.68], TX: [-106.65, 25.84, -93.51, 36.5], UT: [-114.05, 37.0, -109.04, 42.0],
  VT: [-73.44, 42.73, -71.46, 45.02], VA: [-83.68, 36.54, -75.24, 39.47], WA: [-124.76, 45.54, -116.92, 49.0],
  WV: [-82.64, 37.2, -77.72, 40.64], WI: [-92.89, 42.49, -86.8, 47.08], WY: [-111.06, 40.99, -104.05, 45.01],
  PR: [-67.95, 17.88, -65.22, 18.52],
};

/**
 * States whose envelope contains the point, smallest envelope first. Envelopes
 * overlap along borders, which is why this returns a list: the boundary hook
 * loads the first two so a view straddling a border draws both sides.
 */
export function statesForPoint(lat: number, lng: number): string[] {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
  const hits: Array<[string, number]> = [];
  for (const [st, [w, s, e, n]] of Object.entries(STATE_BBOX)) {
    if (lng >= w && lng <= e && lat >= s && lat <= n) hits.push([st, (e - w) * (n - s)]);
  }
  return hits.sort((a, b) => a[1] - b[1]).map(([st]) => st);
}

/** Centre of a state's envelope (a map anchor, not a centroid). */
export function stateCenter(st: string): { lat: number; lng: number } | null {
  const b = STATE_BBOX[st];
  return b ? { lat: (b[1] + b[3]) / 2, lng: (b[0] + b[2]) / 2 } : null;
}

/**
 * States whose envelope intersects the view, nearest to the view centre
 * first (distance from the centre to the envelope: 0 when it contains it,
 * ties broken by distance to the envelope's centre).
 */
export function statesIntersectingBounds(bounds: { south: number; west: number; north: number; east: number }): string[] {
  const { south, west, north, east } = bounds;
  if (![south, west, north, east].every(Number.isFinite)) return [];
  const wraps = east < west;
  const cLat = (south + north) / 2;
  const cLng = wraps ? (((west + (east + 360 - west) / 2) + 540) % 360) - 180 : (west + east) / 2;
  const cos = Math.cos((cLat * Math.PI) / 180);
  const lngOverlaps = (w: number, e: number) => (wraps ? e >= west || w <= east : e >= west && w <= east);
  const hits: Array<[string, number, number]> = [];
  for (const [st, [w, s, e, n]] of Object.entries(STATE_BBOX)) {
    if (n < south || s > north || !lngOverlaps(w, e)) continue;
    const dLat = Math.max(s - cLat, 0, cLat - n);
    const dLng = Math.max(w - cLng, 0, cLng - e) * cos;
    const toCentre = Math.hypot((s + n) / 2 - cLat, ((w + e) / 2 - cLng) * cos);
    hits.push([st, Math.hypot(dLat, dLng), toCentre]);
  }
  return hits.sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([st]) => st);
}

// ─── Boundary layers ────────────────────────────────────────────────────────

/** Left-panel toggles → the upstream boundary layers each one draws. */
export const CIVIC_BOUNDARY_TOGGLES = {
  civic_congressional: ['congressional_district'],
  civic_state_senate: ['state_senate_district'],
  civic_state_house: ['state_house_district'],
  civic_school_districts: ['school_district', 'school_district_elementary', 'school_district_secondary'],
  civic_counties: ['county'],
  civic_places: ['place'],
} as const satisfies Record<string, readonly CivicBoundaryLayer[]>;
export type CivicBoundaryToggle = keyof typeof CIVIC_BOUNDARY_TOGGLES;
export const CIVIC_BOUNDARY_TOGGLE_KEYS = Object.keys(CIVIC_BOUNDARY_TOGGLES) as CivicBoundaryToggle[];

/** Line colour per toggle; the legend reads the same table. */
export const CIVIC_BOUNDARY_STYLE: Record<CivicBoundaryToggle, { color: string; label: string; dash?: number[] }> = {
  civic_congressional: { color: '#a78bfa', label: 'Congressional district (violet line)' },
  civic_state_senate: { color: '#f59e0b', label: 'State senate district (amber line)' },
  civic_state_house: { color: '#f472b6', label: 'State house district (pink dashed line)', dash: [3, 2] },
  civic_school_districts: { color: '#34d399', label: 'School district (green line)' },
  civic_counties: { color: '#94a3b8', label: 'County (slate line)', dash: [4, 2] },
  civic_places: { color: '#38bdf8', label: 'City / incorporated place (sky line)' },
};

/** Map-layer id prefix; the click handler recognises boundary fills by it. */
export const CIVIC_BOUNDARY_LAYER_PREFIX = 'civic-boundary-';
export const civicBoundaryFillId = (k: CivicBoundaryToggle) => `${CIVIC_BOUNDARY_LAYER_PREFIX}${k}-fill`;
export const civicBoundaryLineId = (k: CivicBoundaryToggle) => `${CIVIC_BOUNDARY_LAYER_PREFIX}${k}-line`;

export const CIVIC_DISTRICT_ENTITY_TYPE = 'civic_district';

export type CivicBoundaryMeta = {
  layer: string;
  state: string;
  source_url: string;
  license: string;
  retrieved_at: string;
  stale: boolean;
  feature_count: number;
};

type PolyGeometry = GeoJSON.Polygon | GeoJSON.MultiPolygon;

/** Upstream boundary collection → clickable features with only the fields a map labels. */
export function sanitizeCivicBoundaries(
  raw: unknown,
  limit = 5000,
): { fc: GeoJSON.FeatureCollection<PolyGeometry>; meta: CivicBoundaryMeta } | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (c.type !== 'FeatureCollection' || !Array.isArray(c.features)) return null;
  const layer = typeof c.kind === 'string' ? c.kind : '';
  const state = typeof c.state === 'string' ? c.state : '';
  const features: GeoJSON.Feature<PolyGeometry>[] = [];
  for (const item of c.features as unknown[]) {
    if (features.length >= limit) break;
    const f = item as { geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> } | null;
    const g = f?.geometry;
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon') || !Array.isArray(g.coordinates)) continue;
    const p = f?.properties && typeof f.properties === 'object' ? f.properties : {};
    const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
    const kind = str(p.kind) || layer;
    const geoid = str(p.geoid);
    const name = str(p.name);
    features.push({
      type: 'Feature',
      geometry: g as PolyGeometry,
      properties: {
        type: CIVIC_DISTRICT_ENTITY_TYPE,
        id: `${CIVIC_DISTRICT_ENTITY_TYPE}-${kind}-${geoid || features.length}`,
        kind,
        geoid,
        name,
        district: str(p.district),
        state,
      },
    });
  }
  return {
    fc: { type: 'FeatureCollection', features },
    meta: {
      layer,
      state,
      source_url: typeof c.source_url === 'string' ? c.source_url : '',
      license: typeof c.license === 'string' ? c.license : '',
      retrieved_at: typeof c.retrieved_at === 'string' ? c.retrieved_at : '',
      stale: c.stale === true,
      feature_count: features.length,
    },
  };
}

// ─── Map click → "who represents here" ──────────────────────────────────────

export const CIVIC_LOOKUP_EVENT = 'sb:civic-lookup';

export type CivicLookupRequest = {
  lat: number;
  lng: number;
  /** The boundary the user clicked, when they clicked one: the panel opens that group. */
  focusKind?: string;
  focusName?: string;
};

type ClickFeature = { layer?: { id?: string } | null; properties?: Record<string, unknown> | null };

/**
 * Should this map click become a civic lookup? Yes when it landed on a civic
 * boundary or when "who represents here" is on — but ONLY if no other entity
 * (flight, ship, camera, civic dot…) is under the cursor, so boundaries never
 * steal a click from something the operator meant to select. A click outside
 * every US state envelope is not spent against the upstream quota.
 */
export function civicLookupFromMapClick(
  lngLat: { lat: number; lng: number },
  features: ClickFeature[] | undefined,
  representativesOn: boolean,
): CivicLookupRequest | null {
  const list = features ?? [];
  const boundary = list.find((f) => (f.layer?.id || '').startsWith(CIVIC_BOUNDARY_LAYER_PREFIX));
  const other = list.some((f) => !(f.layer?.id || '').startsWith(CIVIC_BOUNDARY_LAYER_PREFIX));
  if (other) return null;
  if (!boundary && !representativesOn) return null;
  if (!boundary && statesForPoint(lngLat.lat, lngLat.lng).length === 0) return null;
  const p = boundary?.properties ?? {};
  return {
    lat: lngLat.lat,
    lng: lngLat.lng,
    ...(boundary ? { focusKind: String(p.kind ?? ''), focusName: String(p.name ?? '') } : {}),
  };
}

export function dispatchCivicLookup(req: CivicLookupRequest): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<CivicLookupRequest>(CIVIC_LOOKUP_EVENT, { detail: req }));
}

/** Only http(s) links from upstream data become anchors; anything else (javascript:, data:) renders as text. */
export function civicSafeHref(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 2048) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Which panel group a clicked boundary kind opens. */
export function groupForBoundaryKind(kind: string | undefined): CivicGroupKey | null {
  return (kind && JURISDICTION_GROUP[kind]) || null;
}
