/**
 * WebMCP tool registry: shapes, argument validation, result bounding/redaction,
 * map-view actions, and navigator.modelContext registration (both API styles).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createShadowbrokerTools,
  registerWebMcpTools,
  ToolRegistry,
  type ToolContext,
} from '@/lib/webmcp';
import { boundResult, clampLimit, MAX_LIST, MAX_RESULT_CHARS, redactUrl, trimEntity } from '@/lib/webmcp/bound';
import { inBounds } from '@/lib/webmcp/layers';

function makeCtx(store: Record<string, unknown>, overrides: Partial<ToolContext> = {}) {
  const flyTo = vi.fn();
  const setLayer = vi.fn();
  const fetchJson = vi.fn(async () => ({}));
  const ctx: ToolContext = {
    readStore: () => store,
    getBounds: () => null,
    getActiveLayers: () => ({ flights: true, military: false, cctv: true, ships_cargo: false }),
    map: { flyTo, setLayer },
    fetchJson,
    ...overrides,
  };
  return { ctx, flyTo, setLayer, fetchJson, registry: new ToolRegistry(createShadowbrokerTools(), ctx) };
}

const manyFlights = Array.from({ length: 500 }, (_, i) => ({
  callsign: `UAL${i}`,
  country: 'United States',
  lat: 40 + (i % 10) * 0.1,
  lng: -74 + (i % 10) * 0.1,
  alt: 30000,
  registration: `N${i}UA`,
  model: 'B738',
  trail: Array.from({ length: 200 }, () => ({ lat: 1, lng: 2 })),
  api_token: 'sk-should-never-leak',
}));

const store = {
  commercial_flights: manyFlights,
  military_flights: [{ callsign: 'RCH123', country: 'USA', lat: 44.1, lng: 33.2, model: 'C17', military_type: 'cargo' }],
  ships: [{ mmsi: 211331640, name: 'EVER GIVEN', lat: 30.0, lng: 32.5, country: 'Panama', type: 'cargo' }],
  cctv: [{ id: 'cam-7', lat: 51.5, lon: -0.12, source_agency: 'TfL', media_url: 'https://cams.example/x.jpg?apikey=SECRET&size=2' }],
  news: [
    { id: 1, title: 'Low story', risk_score: 2, source: 'A', lat: 0, lng: 0, summary: 's' },
    { id: 2, title: 'Critical event in Black Sea', risk_score: 9, source: 'B', lat: 44, lng: 33, summary: 's' },
    { id: 3, title: 'High event', risk_score: 7, source: 'C', lat: 1, lng: 1, summary: 's' },
  ],
  threat_level: { score: 61, level: 'ELEVATED', color: '#f80', drivers: ['x'] },
};

describe('tool registry shape', () => {
  it('exposes the documented tools with valid object schemas', () => {
    const { registry } = makeCtx(store);
    const names = registry.list().map((t) => t.name);
    for (const n of ['search_entities', 'list_layers', 'toggle_layer', 'get_entities_in_view', 'get_entity', 'get_news_feed', 'fly_to', 'get_civic_at', 'get_summary', 'show_entity']) {
      expect(names).toContain(n);
    }
    for (const t of registry.list()) {
      expect(t.inputSchema.type).toBe('object');
      for (const r of t.inputSchema.required ?? []) expect(t.inputSchema.properties).toHaveProperty(r);
      expect(t.description.length).toBeGreaterThan(20);
    }
    const openai = registry.toOpenAITools();
    expect(openai[0]).toMatchObject({ type: 'function', function: { name: expect.any(String), parameters: { type: 'object' } } });
  });

  it('only map-view actions are marked non-read-only', () => {
    const { registry } = makeCtx(store);
    const writers = registry.list().filter((t) => !t.readOnly).map((t) => t.name).sort();
    expect(writers).toEqual(['fly_to', 'show_entity', 'toggle_layer']);
  });
});

describe('bounding and redaction', () => {
  it('caps search results and reports the true total', async () => {
    const { registry } = makeCtx(store);
    const res = await registry.call('search_entities', { query: 'UAL', limit: 500 });
    expect(res.ok).toBe(true);
    const r = res.result as { total_matches: number; matches: unknown[] };
    expect(r.total_matches).toBe(500);
    expect(r.matches.length).toBeLessThanOrEqual(MAX_LIST);
    expect(JSON.stringify(res.result).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
  });

  it('drops trails and secret-looking fields, strips credential query params', async () => {
    const { registry } = makeCtx(store);
    const res = await registry.call('search_entities', { query: 'UAL1', limit: 3 });
    const text = JSON.stringify(res.result);
    expect(text).not.toContain('sk-should-never-leak');
    expect(text).not.toContain('api_token');
    expect(text).not.toContain('trail');
    const cam = await registry.call('get_entity', { id: 'cam-7' });
    const camText = JSON.stringify(cam.result);
    expect(camText).not.toContain('SECRET');
    expect(camText).toContain('size=2');
  });

  it('helpers clamp and trim', () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(9999)).toBe(MAX_LIST);
    expect(clampLimit('x', 7)).toBe(7);
    expect(redactUrl('https://u:p@h.example/a?token=1&b=2')).toBe('https://h.example/a?b=2');
    const t = trimEntity({ a: 'x'.repeat(1000), password: 'p', n: 1.23456, lat: 1.234567 });
    expect((t.a as string).length).toBeLessThanOrEqual(200);
    expect(t).not.toHaveProperty('password');
    expect(t.lat).toBe(1.2346);
    const big = boundResult({ items: Array.from({ length: 2000 }, (_, i) => ({ i, s: 'y'.repeat(50) })) });
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(big).toHaveProperty('truncated', true);
  });
});

describe('tool behaviour', () => {
  it('validates arguments and never throws', async () => {
    const { registry } = makeCtx(store);
    expect(await registry.call('nope', {})).toEqual({ ok: false, error: 'unknown tool "nope"' });
    expect((await registry.call('search_entities', {})).error).toMatch(/missing required argument "query"/);
    expect((await registry.call('fly_to', { lat: 200, lng: 0 })).error).toMatch(/above 90/);
    expect((await registry.call('search_entities', { query: 'x', layer: 'bogus' })).ok).toBe(false);
  });

  it('get_news_feed filters by min_level and sorts by risk', async () => {
    const { registry } = makeCtx(store);
    const res = await registry.call('get_news_feed', { min_level: 7 });
    const r = res.result as { articles: Array<{ risk_score: number }>; threat_level: { level: string } };
    expect(r.articles.map((a) => a.risk_score)).toEqual([9, 7]);
    expect(r.threat_level.level).toBe('ELEVATED');
  });

  it('get_entities_in_view uses the viewport and handles lon/lng', async () => {
    const { registry } = makeCtx(store, { getBounds: () => ({ south: 51, north: 52, west: -1, east: 1 }) });
    const res = await registry.call('get_entities_in_view', { layer: 'cctv' });
    expect((res.result as { total_in_view: number }).total_in_view).toBe(1);
    const none = await registry.call('get_entities_in_view', { layer: 'ships' });
    expect((none.result as { total_in_view: number }).total_in_view).toBe(0);
    expect(inBounds({ lat: 0, lng: 179 }, { south: -1, north: 1, west: 170, east: -170 })).toBe(true);
  });

  it('get_entity finds by MMSI and show_entity flies there', async () => {
    const { registry, flyTo } = makeCtx(store);
    const res = await registry.call('get_entity', { id: '211331640' });
    expect(res.result).toMatchObject({ found: true, entity: { name: 'EVER GIVEN', _layer: 'ships' } });
    await registry.call('show_entity', { id: 'RCH123' });
    expect(flyTo).toHaveBeenCalledWith(44.1, 33.2, 9);
  });

  it('toggle_layer maps data layers to map toggles; rejects unknown keys', async () => {
    const { registry, setLayer } = makeCtx(store);
    await registry.call('toggle_layer', { layer: 'military_flights', enabled: true });
    expect(setLayer).toHaveBeenCalledWith('military', true);
    await registry.call('toggle_layer', { layer: 'cctv', enabled: 'false' });
    expect(setLayer).toHaveBeenCalledWith('cctv', false);
    expect((await registry.call('toggle_layer', { layer: 'wormhole', enabled: true })).ok).toBe(false);
  });

  it('get_civic_at queries the same-origin civic proxy and summarizes', async () => {
    const fetchJson = vi.fn(async (url: string) =>
      url.includes('/projects')
        ? { construction_contracts: { total: 5, top: [{ recipient: 'ACME', amount: 10 }] } }
        : { type: 'FeatureCollection', features: [{ geometry: { coordinates: [-77, 38.9] }, properties: { name: 'cam', operator: 'X' } }] },
    );
    const { registry } = makeCtx(store, { fetchJson });
    const res = await registry.call('get_civic_at', { lat: 38.9, lng: -77, radius_km: 500 });
    expect(fetchJson).toHaveBeenCalledTimes(3);
    for (const [url] of fetchJson.mock.calls) {
      expect(url).toMatch(/^\/api\/civic-proxy\//);
      expect(url).toContain('radius_km=50');
    }
    expect(res.result).toMatchObject({ alpr: { count: 1 }, projects: { construction_contracts: { total: 5 } } });
  });
});

describe('navigator.modelContext registration', () => {
  it('is a no-op without WebMCP', () => {
    const { registry } = makeCtx(store);
    expect(registerWebMcpTools(registry, {}).mode).toBe('unavailable');
  });

  it('uses registerTool and unregisters every tool', async () => {
    const { registry } = makeCtx(store);
    const registered = new Map<string, { execute: (i: unknown) => Promise<{ content: Array<{ text: string }> }> }>();
    const unregisterTool = vi.fn((n: string) => registered.delete(n));
    const mc = { registerTool: vi.fn((t: { name: string; execute: never }) => void registered.set(t.name, t)), unregisterTool };
    const reg = registerWebMcpTools(registry, { modelContext: mc });
    expect(reg.mode).toBe('registerTool');
    expect(registered.size).toBe(registry.list().length);
    const out = await registered.get('get_news_feed')!.execute({ min_level: 9 });
    expect(JSON.parse(out.content[0].text).articles).toHaveLength(1);
    reg.unregister();
    expect(registered.size).toBe(0);
  });

  it('falls back to provideContext and clears it', () => {
    const { registry } = makeCtx(store);
    const provideContext = vi.fn();
    const clearContext = vi.fn();
    const reg = registerWebMcpTools(registry, { modelContext: { provideContext, clearContext } });
    expect(reg.mode).toBe('provideContext');
    expect(provideContext.mock.calls[0][0].tools[0]).toMatchObject({ name: expect.any(String), inputSchema: { type: 'object' } });
    reg.unregister();
    expect(clearContext).toHaveBeenCalled();
  });
});
