import { describe, expect, it } from 'vitest';
import {
  civicElectionsUrl,
  civicLookupFromMapClick,
  civicNameKey,
  civicSafeHref,
  groupCivicLookup,
  lookupCongressionalDistrict,
  lookupCountyFips,
  matchUnitsToJurisdictions,
  officialGroup,
  resolveCivicProxyRequest,
  sanitizeCivicBoundaries,
  statesForPoint,
  type CivicLookupAnswer,
  type CivicUnit,
} from '@/lib/civicDirectory';

const qs = (s: string) => new URLSearchParams(s);

describe('civic proxy allowlist', () => {
  it('keeps the legacy point layers working with their original rules', () => {
    const r = resolveCivicProxyRequest(['alpr'], qs('lat=34&lng=-118&radius_km=50&format=geojson&evil=1'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route.upstreamPath).toBe('/layers/alpr');
    expect(r.route.query).toBe('lat=34&lng=-118&radius_km=50&format=geojson');
    expect(resolveCivicProxyRequest(['alpr'], qs('format=geojson'))).toMatchObject({ ok: false, status: 422 });
  });

  it('refuses unknown routes, extra segments and traversal', () => {
    for (const segs of [[], ['p2025', 'search'], ['status'], ['lookup', 'x'], ['geojson'], ['geojson', '..'],
      ['geojson', 'congressional_district', 'x'], ['how-to-vote'], ['layers', 'alpr'], ['alpr', 'x']]) {
      expect(resolveCivicProxyRequest(segs, qs('state=OH&lat=1&lng=1'))).toMatchObject({ ok: false });
    }
  });

  it('lookup: only lat/lng, range-checked and rounded; addresses never forwarded', () => {
    const r = resolveCivicProxyRequest(['lookup'], qs('lat=39.10234&lng=-84.51234&address=1 Main St'));
    expect(r.ok && r.route.query).toBe('lat=39.102&lng=-84.512');
    expect(r.ok && r.route.upstreamPath).toBe('/lookup');
    expect(resolveCivicProxyRequest(['lookup'], qs('address=1 Main St'))).toMatchObject({ status: 422 });
    expect(resolveCivicProxyRequest(['lookup'], qs('lat=91&lng=0'))).toMatchObject({ status: 422 });
    expect(resolveCivicProxyRequest(['lookup'], qs('lat=1e2&lng=0'))).toMatchObject({ status: 422 });
    expect(resolveCivicProxyRequest(['lookup'], qs('lat=NaN&lng=0'))).toMatchObject({ status: 422 });
  });

  it('how-to-vote: a real state code only, upper-cased', () => {
    const r = resolveCivicProxyRequest(['how-to-vote', 'oh'], qs(''));
    expect(r.ok && r.route.upstreamPath).toBe('/how-to-vote/OH');
    expect(resolveCivicProxyRequest(['how-to-vote', 'ZZ'], qs(''))).toMatchObject({ status: 422 });
    expect(resolveCivicProxyRequest(['how-to-vote', 'OHIO'], qs(''))).toMatchObject({ status: 422 });
  });

  it('geojson: boundaries.LAYERS only, state required', () => {
    const r = resolveCivicProxyRequest(['geojson', 'school_district_elementary'], qs('state=ca&x=1'));
    expect(r.ok && `${r.route.upstreamPath}?${r.route.query}`).toBe('/geojson/school_district_elementary?state=CA');
    expect(r.ok && r.route.timeoutMs).toBeGreaterThan(60000);
    expect(resolveCivicProxyRequest(['geojson', 'tracts'], qs('state=CA'))).toMatchObject({ status: 404 });
    expect(resolveCivicProxyRequest(['geojson', 'county'], qs(''))).toMatchObject({ status: 422 });
  });

  it('units: county is 3 digits, kind is one of units.KINDS', () => {
    const r = resolveCivicProxyRequest(['units'], qs('state=OH&county=061&kind=school_district'));
    expect(r.ok && r.route.query).toBe('state=OH&county=061&kind=school_district');
    expect(resolveCivicProxyRequest(['units'], qs('state=OH&county=61'))).toMatchObject({ status: 422 });
    expect(resolveCivicProxyRequest(['units'], qs('state=OH&kind=special_district'))).toMatchObject({ status: 422 });
  });

  it('elections: district normalised, junk refused', () => {
    const r = resolveCivicProxyRequest(['elections'], qs('state=OH&district=01'));
    expect(r.ok && r.route.query).toBe('state=OH&district=1');
    expect(resolveCivicProxyRequest(['elections'], qs('state=OH&district=at-large'))).toMatchObject({ status: 422 });
    expect(civicElectionsUrl('OH', '01')).toBe('/api/civic-proxy/elections?state=OH&district=1');
  });
});

// Shapes captured from https://app.aitherium.com/api/civic/lookup?lat=39.10&lng=-84.51 (2026-10-30).
const LOOKUP: CivicLookupAnswer = {
  matched: true,
  point: { lat: 39.1, lng: -84.51 },
  state: 'OH',
  jurisdictions: [
    { kind: 'state', geoid: '39', name: 'Ohio' },
    { kind: 'county', geoid: '39061', name: 'Hamilton County' },
    { kind: 'place', geoid: '3915000', name: 'Cincinnati city' },
    { kind: 'school_district', geoid: '3904375', name: 'Cincinnati City School District' },
    { kind: 'congressional_district', geoid: '3901', name: 'Congressional District 1', district: '01' },
    { kind: 'state_senate_district', geoid: '39009', name: 'State Senate District 9', district: '009' },
  ],
  officials: [
    { name: 'Greg Landsman', office: 'U.S. Representative', level: 'federal', district: '1' },
    { name: 'Gov', office: 'Governor', level: 'state', jurisdiction: 'ocd-jurisdiction/country:us/state:oh/government' },
    { name: 'Aftab Pureval', office: 'Mayor', level: 'local', jurisdiction: 'ocd-jurisdiction/country:us/state:oh/place:cincinnati/government' },
    { name: 'Commish', office: 'Commissioner', level: 'local', jurisdiction: 'ocd-jurisdiction/country:us/state:oh/county:hamilton/government' },
    { name: 'Board', office: 'Board Member', level: 'local', jurisdiction: 'ocd-jurisdiction/country:us/state:oh/school_district:cps' },
  ],
  vacancies: [{ office: 'State Representative', district: '24', note: 'none listed' }],
};

const UNITS: CivicUnit[] = [
  { id: 'c', kind: 'county', name: 'COUNTY OF HAMILTON', county_fips: '061' },
  { id: 'm', kind: 'municipality', name: 'CITY OF CINCINNATI', county_fips: '061' },
  { id: 'm2', kind: 'municipality', name: 'VILLAGE OF ADDYSTON', county_fips: '061' },
  { id: 's', kind: 'school_district', name: 'CINCINNATI CITY SCH DIST', county_fips: '061' },
  { id: 's2', kind: 'school_district', name: 'NORTH COLLEGE HILL CITY SCH DIST', county_fips: '061' },
  { id: 'x', kind: 'school_district', name: 'CINCINNATI CITY SCH DIST', county_fips: '017' },
];

describe('civic lookup shaping', () => {
  it('groups officials Federal / State / County / City / School board', () => {
    const groups = groupCivicLookup(LOOKUP, UNITS);
    expect(groups.map((g) => g.key)).toEqual(['federal', 'state', 'county', 'city', 'school']);
    const by = Object.fromEntries(groups.map((g) => [g.key, g]));
    expect(by.federal.officials.map((o) => o.name)).toEqual(['Greg Landsman']);
    expect(by.state.vacancies).toHaveLength(1);
    expect(by.county.officials.map((o) => o.name)).toEqual(['Commish']);
    expect(by.city.officials.map((o) => o.name)).toEqual(['Aftab Pureval']);
    expect(by.school.officials.map((o) => o.name)).toEqual(['Board']);
    expect(by.school.jurisdictions[0].name).toBe('Cincinnati City School District');
  });

  it("attaches only that place's own governments from the county directory", () => {
    const ids = matchUnitsToJurisdictions(UNITS, LOOKUP.jurisdictions!).map((u) => u.id);
    expect(ids.sort()).toEqual(['c', 'm', 's']);
  });

  it('normalises Census and Census-of-Governments names to one key', () => {
    expect(civicNameKey('Cincinnati City School District')).toBe(civicNameKey('CINCINNATI CITY SCH DIST'));
    expect(civicNameKey('Cincinnati city')).toBe(civicNameKey('CITY OF CINCINNATI'));
    expect(civicNameKey('North College Hill city')).not.toBe(civicNameKey('Cincinnati city'));
  });

  it('extracts the district and county keys the follow-up reads need', () => {
    expect(lookupCongressionalDistrict(LOOKUP)).toBe('1');
    expect(lookupCountyFips(LOOKUP)).toBe('061');
    expect(groupCivicLookup({ matched: false })).toEqual([]);
  });

  it('classifies a local official with no OCD id by office', () => {
    expect(officialGroup({ level: 'local', office: 'Sheriff' })).toBe('county');
    expect(officialGroup({ level: 'local', office: 'Council Member' })).toBe('city');
    expect(officialGroup({ level: 'local', office: 'Board of Education Member' })).toBe('school');
    expect(officialGroup({ level: 'local', office: 'Coroner' })).toBe('local');
  });

  it('never turns a non-http link from upstream data into an anchor', () => {
    expect(civicSafeHref('https://vote.gov/')).toBe('https://vote.gov/');
    expect(civicSafeHref('javascript:alert(1)')).toBeNull();
    expect(civicSafeHref('data:text/html,x')).toBeNull();
    expect(civicSafeHref(undefined)).toBeNull();
  });
});

describe('civic boundaries', () => {
  it('keeps polygons, tags them clickable, carries provenance', () => {
    const out = sanitizeCivicBoundaries({
      type: 'FeatureCollection',
      kind: 'congressional_district',
      state: 'OH',
      source_url: 'https://tigerweb.geo.census.gov/',
      license: 'US Government work (public domain)',
      retrieved_at: '2026-10-28T15:04:21Z',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [[[-84.8, 39.1], [-84.5, 39.1], [-84.5, 39.3], [-84.8, 39.1]]] },
          properties: { geoid: '3901', name: 'Congressional District 1', kind: 'congressional_district', district: '01' },
        },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
        { type: 'Feature', geometry: null, properties: {} },
      ],
    });
    expect(out?.fc.features).toHaveLength(1);
    expect(out?.fc.features[0].properties).toMatchObject({
      type: 'civic_district',
      id: 'civic_district-congressional_district-3901',
      district: '01',
      state: 'OH',
    });
    expect(out?.meta).toMatchObject({ layer: 'congressional_district', license: 'US Government work (public domain)', stale: false });
    expect(sanitizeCivicBoundaries({ type: 'Nope' })).toBeNull();
  });

  it('picks the state(s) under a point, smallest envelope first', () => {
    expect(statesForPoint(39.1, -84.51)[0]).toBe('OH');
    expect(statesForPoint(38.9, -77.03)[0]).toBe('DC');
    expect(statesForPoint(48.85, 2.35)).toEqual([]);
  });
});

describe('map click → civic lookup', () => {
  const at = { lat: 39.1, lng: -84.51 };
  const boundary = { layer: { id: 'civic-boundary-civic_congressional-fill' }, properties: { kind: 'congressional_district', name: 'CD 1' } };
  const flight = { layer: { id: 'flights-layer' }, properties: { type: 'flight' } };

  it('a district click looks up that point and focuses its group', () => {
    expect(civicLookupFromMapClick(at, [boundary], false)).toEqual({ ...at, focusKind: 'congressional_district', focusName: 'CD 1' });
  });

  it('never steals a click from an entity under the cursor', () => {
    expect(civicLookupFromMapClick(at, [boundary, flight], true)).toBeNull();
  });

  it('empty-map clicks look up only when "who represents here" is on, and only in the US', () => {
    expect(civicLookupFromMapClick(at, [], false)).toBeNull();
    expect(civicLookupFromMapClick(at, [], true)).toEqual(at);
    expect(civicLookupFromMapClick({ lat: 48.85, lng: 2.35 }, [], true)).toBeNull();
  });
});
