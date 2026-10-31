import { describe, expect, it } from 'vitest';
import {
  CIVIC_MAX_STATES,
  civicAnswerTruncated,
  civicAreaFromBounds,
  civicAreaRequests,
  mergeCivicPoints,
} from '@/lib/civicLayers';
import { statesIntersectingBounds } from '@/lib/civicDirectory';
import { estimateViewBounds, visibleViewChanged } from '@/lib/liveDataViewport';

// Owner report: zoomed out on the US the civic layers showed almost nothing,
// because every view was reduced to ONE 50 km circle around its centre.
describe('civic area: circle zoomed in, states zoomed out', () => {
  it('a city view stays one 50 km circle', () => {
    const area = civicAreaFromBounds({ south: 39.0, west: -84.7, north: 39.2, east: -84.3 });
    expect(area.kind).toBe('circle');
    const reqs = civicAreaRequests('civic_alpr', area);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].url).toMatch(/^\/api\/civic-proxy\/alpr\?lat=39\.1&lng=-84\.5&radius_km=\d+&format=geojson$/);
  });

  it('a continental view loads up to six states, the centre state first', () => {
    // Whole lower 48, centred on Kansas.
    const area = civicAreaFromBounds({ south: 24, west: -125, north: 50, east: -66 });
    expect(area.kind).toBe('states');
    if (area.kind !== 'states') return;
    expect(area.states).toHaveLength(CIVIC_MAX_STATES);
    expect(area.states[0]).toBe('KS');
    expect(area.skipped.length).toBeGreaterThan(30);
    expect(area.label).toMatch(/^KS, .* \(state-wide\) · \d+ more states in view not loaded — zoom in$/);
    const urls = civicAreaRequests('civic_datacenters', area).map((r) => r.url);
    expect(urls[0]).toBe('/api/civic-proxy/datacenters?state=KS&format=geojson&leads=0');
    expect(urls).toHaveLength(CIVIC_MAX_STATES);
  });

  it('a regional view loads every state it touches when there are few', () => {
    const area = civicAreaFromBounds({ south: 38.5, west: -85.5, north: 41.5, east: -80.0 });
    expect(area.kind).toBe('states');
    if (area.kind !== 'states') return;
    expect(area.states[0]).toBe('OH');
    expect(area.states).toEqual(expect.arrayContaining(['OH', 'IN', 'KY', 'WV', 'PA']));
    expect(area.skipped).toEqual([]);
  });

  it('projects become one pin per state, anchored inside it', () => {
    const area = civicAreaFromBounds({ south: 38.5, west: -85.5, north: 41.5, east: -80.0 });
    const reqs = civicAreaRequests('civic_projects', area);
    expect(reqs[0].url).toBe('/api/civic-proxy/projects?state=OH');
    expect(reqs[0].anchor.lat).toBeGreaterThan(38.4);
    expect(reqs[0].anchor.lat).toBeLessThan(42);
  });

  it('open ocean falls back to the circle instead of loading nothing', () => {
    expect(civicAreaFromBounds({ south: 30, west: -50, north: 45, east: -30 }).kind).toBe('circle');
  });

  it('nearest-to-centre ordering', () => {
    expect(statesIntersectingBounds({ south: 33.5, west: -119, north: 34.5, east: -117.5 })[0]).toBe('CA');
    expect(statesIntersectingBounds({ south: 10, west: 0, north: 20, east: 10 })).toEqual([]);
  });

  it('merged state answers keep unique, clickable ids and report upstream caps', () => {
    const fc = (lng: number) => ({
      type: 'FeatureCollection' as const,
      features: [{ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [lng, 40] }, properties: { type: 'civic_alpr', id: 'civic_alpr-0' } }],
    });
    const merged = mergeCivicPoints([fc(-84), null, fc(-86)], 'civic_alpr');
    expect(merged?.features.map((f) => f.properties?.id)).toEqual(['civic_alpr-0', 'civic_alpr-1']);
    expect(mergeCivicPoints([null], 'civic_alpr')).toBeNull();
    expect(civicAnswerTruncated({ metadata: { features_truncated: true, count: 9000 } })).toEqual({ truncated: true, count: 9000 });
    expect(civicAnswerTruncated({})).toEqual({ truncated: false, count: null });
  });
});

describe('visible view tracking', () => {
  it('a zoom with the same centre counts as a change (the preload window would not move)', () => {
    const us = { south: 24, west: -125, north: 50, east: -66 };
    const city = { south: 36.9, west: -95.9, north: 37.1, east: -95.6 };
    expect(visibleViewChanged(us, city)).toBe(true);
    expect(visibleViewChanged(city, { ...city, west: city.west + 0.01, east: city.east + 0.01 })).toBe(false);
    expect(visibleViewChanged(null, city)).toBe(true);
  });

  it('estimates the on-screen box for a fly-to target', () => {
    const b = estimateViewBounds(34.05, -118.25, 8, 1280, 800);
    expect(b.south).toBeLessThan(34.05);
    expect(b.north).toBeGreaterThan(34.05);
    expect(b.east - b.west).toBeCloseTo((1280 * 360) / (512 * 256), 5);
    // Zoom 8 is ~380 km across: wider than the 50 km circle, so it loads the state.
    const area = civicAreaFromBounds(b);
    expect(area.kind === 'states' && area.states[0]).toBe('CA');
    // Zoom 11 is ~50 km across: one circle at the searched point.
    const close = civicAreaFromBounds(estimateViewBounds(34.05, -118.25, 11, 1280, 800));
    expect(close.kind === 'circle' && [close.query.lat, close.query.lng]).toEqual([34.05, -118.25]);
  });
});
