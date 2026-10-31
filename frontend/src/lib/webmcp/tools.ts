/**
 * The ShadowBroker tool set. Every data tool is READ-ONLY over the live store or
 * a same-origin GET; the only side effects are map-view actions (fly_to,
 * toggle_layer), which change what the operator looks at and nothing else.
 */
import { civicLayerUrl, CIVIC_MAX_RADIUS_KM, type CivicLayerKey } from '@/lib/civicLayers';
import {
  CIVIC_STATE_CODES,
  CIVIC_UNIT_KINDS,
  civicElectionsUrl,
  civicLookupUrl,
  civicUnitsUrl,
} from '@/lib/civicDirectory';
import { CANDIDATE_ID, candidatePageUrl, federalCandidatesUrl, fecOfficeFor, type FecOffice } from '@/lib/civicCandidates';
import { clampLimit, DEFAULT_LIST, redactDeep, trimEntity } from './bound';
import {
  DATA_LAYERS,
  entityId,
  entityLatLng,
  getLayer,
  inBounds,
  LAYER_GROUPS,
  layerItems,
  matchesId,
  matchesQuery,
  resolveLayers,
} from './layers';
import type { JsonSchemaProperty, LiveBounds, ToolDefinition } from './types';

const LAYER_DESC =
  `Data layer id (${DATA_LAYERS.map((l) => l.id).join(', ')}) or group (${Object.keys(LAYER_GROUPS).join(', ')}).`;

function summarize(layerId: string, item: unknown, maxFields = 12): Record<string, unknown> {
  return { _layer: layerId, _id: entityId(item), ...trimEntity(item, { maxFields }) };
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function requireLatLng(args: Record<string, unknown>): { lat: number; lng: number } {
  const lat = num(args.lat);
  const lng = num(args.lng);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new Error('lat must be within [-90, 90] and lng within [-180, 180]');
  }
  return { lat, lng };
}

function parseBbox(value: unknown): LiveBounds | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [west, south, east, north] = value.map(Number);
  if (![west, south, east, north].every(Number.isFinite)) return null;
  if (south > north || Math.abs(south) > 90 || Math.abs(north) > 90) return null;
  return { west, south, east, north };
}

function unknownLayerError(layer: unknown): Error {
  return new Error(`unknown layer "${String(layer)}". Call list_layers for valid ids.`);
}

const listLayers: ToolDefinition = {
  name: 'list_layers',
  description:
    'List every data layer on the ShadowBroker map with its entity count and whether it is shown. Call this first to learn what data exists.',
  inputSchema: { type: 'object', properties: {} },
  readOnly: true,
  async execute(_args, ctx) {
    const store = ctx.readStore();
    const active = ctx.getActiveLayers();
    return {
      layers: DATA_LAYERS.map((l) => ({
        id: l.id,
        label: l.label,
        count: layerItems(store, l.id).length,
        shown: l.toggles.length === 0 ? true : l.toggles.some((t) => active[t]),
        toggles: l.toggles,
      })),
      groups: LAYER_GROUPS,
    };
  },
};

const toggleLayer: ToolDefinition = {
  name: 'toggle_layer',
  description:
    'Show or hide a map layer. Accepts a map toggle key (e.g. "flights", "ships_cargo", "cctv", "civic_alpr") or a data layer id, which switches all of its toggles. Map-view action only.',
  inputSchema: {
    type: 'object',
    properties: {
      layer: { type: 'string', description: 'Map toggle key or data layer id.' },
      enabled: { type: 'boolean', description: 'true to show, false to hide.' },
    },
    required: ['layer', 'enabled'],
  },
  readOnly: false,
  async execute(args, ctx) {
    const key = String(args.layer ?? '').trim();
    const enabled = args.enabled === true;
    const active = ctx.getActiveLayers();
    const toggles = key in active ? [key] : [...(getLayer(key)?.toggles ?? [])];
    if (toggles.length === 0) {
      throw new Error(`"${key}" is not a toggleable layer. Toggle keys: ${Object.keys(active).join(', ')}`);
    }
    for (const t of toggles) ctx.map.setLayer(t, enabled);
    return { layer: key, toggles, enabled };
  },
};

const searchEntities: ToolDefinition = {
  name: 'search_entities',
  description:
    'Search live map entities (flights, ships, satellites, CCTV, bases, data centers, news, ...) by text: callsign, name, registration, MMSI, country, operator, title. Returns compact matches with layer, id and coordinates.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Case-insensitive text to match.' },
      layer: { type: 'string', description: `Optional. ${LAYER_DESC}` },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: `Max results (default ${DEFAULT_LIST}).` },
    },
    required: ['query'],
  },
  readOnly: true,
  async execute(args, ctx) {
    const query = String(args.query ?? '').trim();
    if (query.length < 2) throw new Error('query must be at least 2 characters');
    const layers = resolveLayers(args.layer);
    if (layers.length === 0) throw unknownLayerError(args.layer);
    const limit = clampLimit(args.limit);
    const store = ctx.readStore();
    const matches: Record<string, unknown>[] = [];
    let total = 0;
    for (const layerId of layers) {
      for (const item of layerItems(store, layerId)) {
        if (!matchesQuery(item, query)) continue;
        total += 1;
        if (matches.length < limit) matches.push(summarize(layerId, item, 10));
      }
    }
    return { query, total_matches: total, returned: matches.length, matches };
  },
};

const getEntitiesInView: ToolDefinition = {
  name: 'get_entities_in_view',
  description:
    'List entities of one layer inside the current map viewport (or an explicit bbox). Use it to answer "what is on screen" questions.',
  inputSchema: {
    type: 'object',
    properties: {
      layer: { type: 'string', description: LAYER_DESC },
      bbox: {
        type: 'array',
        items: { type: 'number' },
        description: 'Optional [west, south, east, north] in degrees. Defaults to the visible map.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: `Max results (default ${DEFAULT_LIST}).` },
    },
    required: ['layer'],
  },
  readOnly: true,
  async execute(args, ctx) {
    const layers = resolveLayers(args.layer);
    if (layers.length === 0 || args.layer === undefined) throw unknownLayerError(args.layer);
    const explicit = args.bbox === undefined ? null : parseBbox(args.bbox);
    if (args.bbox !== undefined && !explicit) throw new Error('bbox must be [west, south, east, north]');
    const bounds = explicit ?? ctx.getBounds();
    const limit = clampLimit(args.limit);
    const store = ctx.readStore();
    const items: Record<string, unknown>[] = [];
    let total = 0;
    for (const layerId of layers) {
      for (const item of layerItems(store, layerId)) {
        const p = entityLatLng(item);
        if (!p || (bounds && !inBounds(p, bounds))) continue;
        total += 1;
        if (items.length < limit) items.push(summarize(layerId, item, 10));
      }
    }
    return { layer: args.layer, bbox: bounds ?? 'world', total_in_view: total, returned: items.length, items };
  },
};

const getEntity: ToolDefinition = {
  name: 'get_entity',
  description:
    'Get the details of one entity by id (id, MMSI, ICAO hex, callsign, registration or exact name). Optionally restrict to a layer.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Identifier to look up.' },
      layer: { type: 'string', description: `Optional. ${LAYER_DESC}` },
    },
    required: ['id'],
  },
  readOnly: true,
  async execute(args, ctx) {
    const id = String(args.id ?? '').trim();
    if (!id) throw new Error('id is required');
    const layers = resolveLayers(args.layer);
    if (layers.length === 0) throw unknownLayerError(args.layer);
    const store = ctx.readStore();
    for (const layerId of layers) {
      const hit = layerItems(store, layerId).find((item) => matchesId(item, id));
      if (hit) return { found: true, entity: summarize(layerId, hit, 30) };
    }
    return { found: false, id, hint: 'Try search_entities with part of the name.' };
  },
};

const getNewsFeed: ToolDefinition = {
  name: 'get_news_feed',
  description:
    'Get the global threat level and the news/threat feed sorted by risk score (0-10; >=7 high, >=9 critical).',
  inputSchema: {
    type: 'object',
    properties: {
      min_level: { type: 'number', minimum: 0, maximum: 10, description: 'Minimum risk score (default 0).' },
      query: { type: 'string', description: 'Optional text filter on title/summary/source/region.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: `Max articles (default ${DEFAULT_LIST}).` },
    },
  },
  readOnly: true,
  async execute(args, ctx) {
    const store = ctx.readStore();
    const min = num(args.min_level) ?? 0;
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const limit = clampLimit(args.limit);
    const news = layerItems(store, 'news')
      .filter((a) => (num((a as Record<string, unknown>)?.risk_score) ?? 0) >= min)
      .filter((a) => !query || matchesQuery(a, query))
      .sort(
        (a, b) =>
          (num((b as Record<string, unknown>).risk_score) ?? 0) - (num((a as Record<string, unknown>).risk_score) ?? 0),
      );
    const threat = store.threat_level as Record<string, unknown> | undefined;
    return {
      threat_level: threat ? trimEntity(threat, { maxFields: 6 }) : null,
      total: news.length,
      articles: news.slice(0, limit).map((a) => {
        const rec = a as Record<string, unknown>;
        return trimEntity(
          {
            id: rec.id,
            title: rec.title,
            source: rec.source,
            risk_score: rec.risk_score,
            region: rec.region,
            pub_date: rec.pub_date,
            summary: rec.summary,
            link: rec.link,
            lat: rec.lat,
            lng: rec.lng,
          },
          { maxString: 240 },
        );
      }),
    };
  },
};

const getSummary: ToolDefinition = {
  name: 'get_summary',
  description:
    'Snapshot of the whole board: entity counts per layer, threat level, data freshness and the visible map area.',
  inputSchema: { type: 'object', properties: {} },
  readOnly: true,
  async execute(_args, ctx) {
    const store = ctx.readStore();
    const counts: Record<string, number> = {};
    for (const l of DATA_LAYERS) {
      const n = layerItems(store, l.id).length;
      if (n > 0) counts[l.id] = n;
    }
    return {
      counts,
      threat_level: store.threat_level ? trimEntity(store.threat_level, { maxFields: 6 }) : null,
      last_updated: typeof store.last_updated === 'string' ? store.last_updated : null,
      viewport: ctx.getBounds() ?? 'world',
      backend_layer_totals: store.layer_totals ? redactDeep(store.layer_totals) : undefined,
    };
  },
};

const flyTo: ToolDefinition = {
  name: 'fly_to',
  description: 'Move the map camera to a point. Map-view action; changes nothing else.',
  inputSchema: {
    type: 'object',
    properties: {
      lat: { type: 'number', minimum: -90, maximum: 90 },
      lng: { type: 'number', minimum: -180, maximum: 180 },
      zoom: { type: 'number', minimum: 1, maximum: 18, description: 'Optional zoom (default 8).' },
    },
    required: ['lat', 'lng'],
  },
  readOnly: false,
  async execute(args, ctx) {
    const { lat, lng } = requireLatLng(args);
    const zoom = Math.max(1, Math.min(18, num(args.zoom) ?? 8));
    ctx.map.flyTo(lat, lng, zoom);
    return { flew_to: { lat, lng, zoom } };
  },
};

const showEntity: ToolDefinition = {
  name: 'show_entity',
  description: 'Fly the map to an entity found by id (same lookup as get_entity) so the operator can see it.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      layer: { type: 'string', description: `Optional. ${LAYER_DESC}` },
      zoom: { type: 'number', minimum: 1, maximum: 18 },
    },
    required: ['id'],
  },
  readOnly: false,
  async execute(args, ctx) {
    const found = (await getEntity.execute(args, ctx)) as { found: boolean; entity?: Record<string, unknown> };
    if (!found.found || !found.entity) return found;
    const p = entityLatLng(found.entity);
    if (!p) return { found: true, shown: false, reason: 'entity has no coordinates', entity: found.entity };
    const zoom = Math.max(1, Math.min(18, num(args.zoom) ?? 9));
    ctx.map.flyTo(p.lat, p.lng, zoom);
    return { found: true, shown: true, entity: found.entity };
  },
};

const CIVIC_LAYERS: Array<{ key: CivicLayerKey; name: string }> = [
  { key: 'civic_alpr', name: 'alpr' },
  { key: 'civic_datacenters', name: 'datacenters' },
  { key: 'civic_projects', name: 'projects' },
];

function summarizeCivic(name: string, body: unknown, limit: number): unknown {
  if (!body || typeof body !== 'object') return { available: false };
  const rec = body as Record<string, unknown>;
  if (Array.isArray(rec.features)) {
    const features = rec.features as Array<Record<string, unknown>>;
    return {
      count: features.length,
      items: features.slice(0, limit).map((f) => {
        const geom = f.geometry as { coordinates?: unknown } | undefined;
        const c = Array.isArray(geom?.coordinates) ? (geom!.coordinates as number[]) : [];
        return trimEntity({ ...(f.properties as object), lng: c[0], lat: c[1] }, { maxFields: 8 });
      }),
    };
  }
  if (name === 'projects') {
    const pick = (k: string) => {
      const part = rec[k] as { total?: number; top?: unknown[] } | undefined;
      return part ? { total: part.total, top: (part.top ?? []).slice(0, limit).map((t) => trimEntity(t, { maxFields: 7 })) } : null;
    };
    return {
      area: redactDeep(rec.area),
      period: redactDeep(rec.period),
      construction_contracts: pick('construction_contracts'),
      infrastructure_grants: pick('infrastructure_grants'),
      source: redactDeep(rec.source),
    };
  }
  return redactDeep(rec);
}

const getCivicAt: ToolDefinition = {
  name: 'get_civic_at',
  description:
    'AitherOS Civic Atlas around a point (US coverage): license-plate readers (ALPR), data centers, and federal construction spending. Radius up to 50 km.',
  inputSchema: {
    type: 'object',
    properties: {
      lat: { type: 'number', minimum: -90, maximum: 90 },
      lng: { type: 'number', minimum: -180, maximum: 180 },
      radius_km: { type: 'number', minimum: 1, maximum: CIVIC_MAX_RADIUS_KM, description: 'Default 25.' },
      layers: {
        type: 'array',
        items: { type: 'string', enum: ['alpr', 'datacenters', 'projects'] },
        description: 'Subset to query (default all three).',
      },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
    required: ['lat', 'lng'],
  },
  readOnly: true,
  async execute(args, ctx, signal) {
    const { lat, lng } = requireLatLng(args);
    const radius_km = Math.max(1, Math.min(CIVIC_MAX_RADIUS_KM, num(args.radius_km) ?? 25));
    const wanted = Array.isArray(args.layers) && args.layers.length > 0 ? args.layers.map(String) : null;
    const limit = clampLimit(args.limit, 10);
    const out: Record<string, unknown> = { lat, lng, radius_km };
    await Promise.all(
      CIVIC_LAYERS.filter((l) => !wanted || wanted.includes(l.name)).map(async (l) => {
        try {
          const body = await ctx.fetchJson(civicLayerUrl(l.key, { lat, lng, radius_km }), signal);
          out[l.name] = summarizeCivic(l.name, body, limit);
        } catch (e) {
          out[l.name] = { error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
    return out;
  },
};


// ─── Civic directory: elections, officials, local governments ───────────────

const US_STATE_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
  louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
  'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

/** "Texas", "tx", "TX" -> "TX". Throws a message the model can act on. */
export function resolveStateCode(v: unknown): string {
  const raw = String(v ?? '').trim();
  const up = raw.toUpperCase();
  if (CIVIC_STATE_CODES.has(up)) return up;
  const byName = US_STATE_NAMES[raw.toLowerCase().replace(/\s+/g, ' ')];
  if (byName && CIVIC_STATE_CODES.has(byName)) return byName;
  throw new Error(`state must be a US state name or two-letter code (got "${raw}")`);
}

const STATE_ARG: JsonSchemaProperty = { type: 'string', description: 'US state: name ("Texas") or two-letter code ("TX").' };

const getElections: ToolDefinition = {
  name: 'get_elections',
  description:
    'Upcoming US elections for a state (federal, state and special elections) plus the official how-to-vote links (registration, polling places, absentee) from the state election office. Use for any question about elections, voting or ballots in a state.',
  inputSchema: {
    type: 'object',
    properties: {
      state: STATE_ARG,
      district: { type: 'string', description: 'Optional US House district number, narrows special elections.' },
    },
    required: ['state'],
  },
  readOnly: true,
  async execute(args, ctx, signal) {
    const state = resolveStateCode(args.state);
    const district = typeof args.district === 'string' || typeof args.district === 'number' ? String(args.district) : undefined;
    const [elections, howToVote] = await Promise.all([
      ctx.fetchJson(civicElectionsUrl(state, district), signal).catch((e) => ({ error: String(e?.message ?? e) })),
      ctx.fetchJson(`/api/civic-proxy/how-to-vote/${state}`, signal).catch((e) => ({ error: String(e?.message ?? e) })),
    ]);
    return { state, elections: redactDeep(elections), how_to_vote: redactDeep(howToVote) };
  },
};

const getOfficialsAt: ToolDefinition = {
  name: 'get_officials_at',
  description:
    'Who represents a US location: every district it sits in and the elected officials for it, federal (President, Senators, House rep), state (governor, legislators), county, city and school board, with how-to-vote links. Needs lat/lng; if the user names a place, use its coordinates (fly_to does not return them, so use your knowledge of the place).',
  inputSchema: {
    type: 'object',
    properties: {
      lat: { type: 'number', minimum: -90, maximum: 90 },
      lng: { type: 'number', minimum: -180, maximum: 180 },
    },
    required: ['lat', 'lng'],
  },
  readOnly: true,
  async execute(args, ctx, signal) {
    const { lat, lng } = requireLatLng(args);
    return { lat, lng, lookup: redactDeep(await ctx.fetchJson(civicLookupUrl(lat, lng), signal)) };
  },
};

const getLocalGovernments: ToolDefinition = {
  name: 'get_local_governments',
  description: `Local governments in a US state: ${CIVIC_UNIT_KINDS.join(', ')} (school boards are school districts). Optional 3-digit county FIPS narrows it.`,
  inputSchema: {
    type: 'object',
    properties: {
      state: STATE_ARG,
      county: { type: 'string', description: 'Optional 3-digit county FIPS code.' },
      kind: { type: 'string', enum: [...CIVIC_UNIT_KINDS], description: 'Optional filter.' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
    required: ['state'],
  },
  readOnly: true,
  async execute(args, ctx, signal) {
    const state = resolveStateCode(args.state);
    const county = typeof args.county === 'string' && /^\d{3}$/.test(args.county) ? args.county : undefined;
    const kind = typeof args.kind === 'string' ? args.kind : '';
    const limit = clampLimit(args.limit, 25);
    const body = (await ctx.fetchJson(civicUnitsUrl(state, county), signal)) as Record<string, unknown> | unknown[];
    const list: unknown[] = Array.isArray(body)
      ? body
      : Array.isArray((body as Record<string, unknown>)?.units)
        ? ((body as Record<string, unknown>).units as unknown[])
        : [];
    const filtered = kind ? list.filter((u) => (u as Record<string, unknown>)?.kind === kind) : list;
    return {
      state,
      county: county ?? null,
      kind: kind || null,
      total: filtered.length,
      units: filtered.slice(0, limit).map((u) => trimEntity(u, { maxFields: 10 })),
    };
  },
};

// ─── Candidates (served by this app: /api/civic-candidates) ──────────────────

/** "house" / "U.S. Senate" / "H" → FEC office code; unknown → null. */
function candidateOffice(v: unknown): FecOffice | null {
  const raw = String(v ?? '').trim();
  if (/^[HSP]$/i.test(raw)) return raw.toUpperCase() as FecOffice;
  return fecOfficeFor(raw);
}

const getCandidates: ToolDefinition = {
  name: 'get_candidates',
  description:
    "Federal candidates (U.S. House, U.S. Senate) registered with the FEC for a state's current election cycle: name, party, incumbent/challenger/open seat, money raised/spent, candidate_id. FEC registration is not ballot status (primary losers appear). State and local candidates are not available from this tool. Pass a candidate_id to get_candidate_page for their platform.",
  inputSchema: {
    type: 'object',
    properties: {
      state: STATE_ARG,
      office: { type: 'string', description: 'Optional: "house" or "senate" (default: both).' },
      district: { type: 'string', description: 'Optional US House district number, e.g. "1".' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max candidates per race (default 15).' },
    },
    required: ['state'],
  },
  readOnly: true,
  async execute(args, ctx, signal) {
    const state = resolveStateCode(args.state);
    const district = typeof args.district === 'string' || typeof args.district === 'number' ? String(args.district).trim() : '';
    if (district && !/^\d{1,2}$/.test(district)) throw new Error('district must be a number like "1"');
    const office = args.office === undefined || args.office === '' ? null : candidateOffice(args.office);
    if (args.office !== undefined && args.office !== '' && !office) throw new Error('office must be "house" or "senate"');
    const offices: FecOffice[] = office ? [office] : district ? ['H'] : ['H', 'S'];
    const limit = Math.min(50, clampLimit(args.limit, 15));
    const races = await Promise.all(
      offices.map(async (o) => {
        try {
          const body = (await ctx.fetchJson(federalCandidatesUrl(state, o, o === 'H' ? district : ''), signal)) as Record<string, unknown>;
          const cands = Array.isArray(body?.candidates) ? (body.candidates as Array<Record<string, unknown>>) : [];
          return {
            office: o === 'H' ? 'U.S. House' : o === 'S' ? 'U.S. Senate' : 'President',
            district: o === 'H' ? district || 'all districts' : '',
            total: cands.length,
            candidates: cands.slice(0, limit).map((c) => ({
              candidate_id: c.id,
              name: c.name,
              party: c.party,
              status: c.status,
              district: c.district,
              money: c.money,
              has_campaign_site: c.has_campaign_site,
              fec_url: Array.isArray(c.links) ? (c.links as Array<Record<string, unknown>>).find((l) => l.kind === 'fec')?.url : undefined,
            })),
            notes: body?.notes,
            source: body?.source,
          };
        } catch (e) {
          return { office: o, error: String((e as Error)?.message ?? e) };
        }
      }),
    );
    return { state, races, state_local: 'State and local candidate lists are not available from this tool.' };
  },
};

const getCandidatePage: ToolDefinition = {
  name: 'get_candidate_page',
  description:
    "Read a candidate's OWN campaign website (the URL in their FEC committee record) as a text excerpt: title, headings, issue-page links and body text. Use it to describe a candidate's platform and policy positions, and cite the returned final_url. It reads only that one page; positions are the campaign's own claims.",
  inputSchema: {
    type: 'object',
    properties: {
      candidate_id: { type: 'string', description: 'candidate_id from get_candidates, e.g. "fec:H6OH01195".' },
    },
    required: ['candidate_id'],
  },
  readOnly: true,
  async execute(args, ctx, signal) {
    const id = String(args.candidate_id ?? '').trim();
    if (!CANDIDATE_ID.test(id)) throw new Error('candidate_id must come from get_candidates (e.g. "fec:H6OH01195")');
    return redactDeep(await ctx.fetchJson(candidatePageUrl(id), signal));
  },
};

/** The full tool set, in the order a model should consider them. */
export function createShadowbrokerTools(): ToolDefinition[] {
  return [
    getSummary,
    listLayers,
    searchEntities,
    getEntitiesInView,
    getEntity,
    getNewsFeed,
    getCivicAt,
    getElections,
    getOfficialsAt,
    getLocalGovernments,
    getCandidates,
    getCandidatePage,
    flyTo,
    showEntity,
    toggleLayer,
  ];
}

/** Exposed for tests. */
export const __test = { parseBbox, summarizeCivic };
