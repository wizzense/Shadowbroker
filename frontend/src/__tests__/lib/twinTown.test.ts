import { describe, expect, it } from 'vitest';
import { getDefaultActiveLayers } from '@/lib/layerPreferences';
import {
  sanitizeTwinTown,
  TWIN_ENTITY_TYPE,
  TWIN_MAX_NEWS,
  TWIN_MAX_VENUES,
  twinLink,
  twinText,
  twinTownAreaFromBounds,
  twinTownChipText,
  twinTownUrl,
  twinWarmingDelayMs,
} from '@/lib/twinTown';

const venue = (i: number, props: Record<string, unknown> = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-84.51 + i * 0.0001, 39.1] },
  properties: {
    layer: 'twin-town',
    kind: 'cafe',
    name: `Venue ${i}`,
    open: true,
    twins_here: 3,
    meetings_hour: 0,
    hour: 14,
    ...props,
  },
});
const happening = (i: number, props: Record<string, unknown> = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-84.5, 39.1] },
  properties: {
    layer: 'twin-news',
    title: `Story ${i}`,
    source: 'Local Paper',
    link: `https://news.test/${i}`,
    published_at: '2026-11-06',
    ...props,
  },
});

describe('twin town layer defaults', () => {
  it('is off by default, venues and news both', () => {
    const d = getDefaultActiveLayers();
    expect(d.twin_town).toBe(false);
    expect(d.twin_town_news).toBe(false);
  });
});

describe('twin town area -> proxy URL', () => {
  const bounds = { south: 39.0, west: -84.6, north: 39.2, east: -84.4 };

  it('sends the same lat/lng circle the civic layers send, as geojson', () => {
    expect(twinTownUrl(twinTownAreaFromBounds(bounds, null))).toBe(
      '/api/civic-proxy/town?lat=39.1&lng=-84.5&radius_km=14&format=geojson',
    );
  });

  it('uses the resolved county while its point is on screen', () => {
    const county = { state: 'OH', county: '061', lat: 39.1, lng: -84.5 };
    expect(twinTownUrl(twinTownAreaFromBounds(bounds, county))).toBe(
      '/api/civic-proxy/town?state=OH&county=061&format=geojson',
    );
    // Panned away from the looked-up point: back to the circle.
    const elsewhere = { south: 34.0, west: -118.4, north: 34.1, east: -118.2 };
    expect(twinTownUrl(twinTownAreaFromBounds(elsewhere, county))).toContain('lat=34.05');
  });

  it('defaults to the civic default circle before the map reports a view', () => {
    expect(twinTownUrl(twinTownAreaFromBounds(null, null))).toBe(
      '/api/civic-proxy/town?lat=38.9072&lng=-77.0369&radius_km=50&format=geojson',
    );
  });
});

describe('warming backoff', () => {
  it('doubles from 5 s and never retries faster than every 30 s', () => {
    expect([0, 1, 2, 3, 4, 20].map(twinWarmingDelayMs)).toEqual([5000, 10000, 20000, 30000, 30000, 30000]);
  });
});

describe('sanitizeTwinTown', () => {
  it('splits venues and news, tags them selectable, and keeps the town meta', () => {
    const out = sanitizeTwinTown({
      type: 'FeatureCollection',
      features: [
        venue(0, { meetings_hour: 2 }),
        happening(0),
        { geometry: { coordinates: ['x', 1] }, properties: { layer: 'twin-town' } },
      ],
      town: {
        id: 't1',
        name: 'Twinford',
        county_fips: '39061',
        residents: 1200,
        synthetic: false,
        as_of: '2026-11-06T14:00:00Z',
        cache_age_s: 30,
      },
    })!;
    expect(out.venues.features).toHaveLength(1);
    const p = out.venues.features[0].properties as Record<string, unknown>;
    expect(p).toMatchObject({
      type: TWIN_ENTITY_TYPE.venue,
      id: 'twin_venue-0',
      open: true,
      twins_here: 3,
      meetings_hour: 2,
      hour: 14,
    });
    expect(out.news).toEqual([
      { title: 'Story 0', source: 'Local Paper', link: 'https://news.test/0', published_at: '2026-11-06' },
    ]);
    expect(out.newsPin.features[0].properties).toMatchObject({ type: TWIN_ENTITY_TYPE.news, count: 1 });
    // A payload can never claim its residents are real.
    expect(out.town).toMatchObject({ name: 'Twinford', residents: 1200, synthetic: true });
    expect(twinTownChipText(out.town!)).toMatch(/^Twinford · 1,200 synthetic twins · as of /);
  });

  it('strips markup from every string and refuses non-http links', () => {
    const out = sanitizeTwinTown({
      type: 'FeatureCollection',
      features: [
        venue(0, { name: '<img src=x onerror=alert(1)>Cafe <b>Bold</b>', kind: '<script>x</script>' }),
        happening(0, { title: 'Hi <a href="javascript:alert(1)">there</a>', link: 'javascript:alert(1)' }),
      ],
      town: { name: '<i>Town</i>' },
    })!;
    const p = out.venues.features[0].properties as Record<string, unknown>;
    expect(p.name).toBe('Cafe Bold');
    expect(String(p.kind)).not.toMatch(/[<>]/);
    expect(out.news[0].title).toBe('Hi there');
    expect(out.news[0].link).toBe('');
    expect(out.town?.name).toBe('Town');
    expect(twinText('a\u0000b<c')).toBe('a b c');
    expect(twinLink('data:text/html,hi')).toBe('');
    expect(twinLink('https://ok.test/a')).toBe('https://ok.test/a');
  });

  it('caps venues at 500 and news at 20', () => {
    const features = [
      ...Array.from({ length: 700 }, (_, i) => venue(i)),
      ...Array.from({ length: 40 }, (_, i) => happening(i)),
    ];
    const out = sanitizeTwinTown({ type: 'FeatureCollection', features })!;
    expect(out.venues.features).toHaveLength(TWIN_MAX_VENUES);
    expect(out.news).toHaveLength(TWIN_MAX_NEWS);
  });

  it('rejects a body that is not a FeatureCollection', () => {
    expect(sanitizeTwinTown({ status: 'warming' })).toBeNull();
    expect(sanitizeTwinTown(null)).toBeNull();
  });
});
