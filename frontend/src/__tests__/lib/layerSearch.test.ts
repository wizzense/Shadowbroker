import { describe, expect, it } from 'vitest';
import { filterLayerSections, isLayerFilterActive, tokenizeLayerQuery } from '@/lib/layerSearch';

const sections = [
  {
    id: 'aircraft',
    label: 'AIRCRAFT',
    layers: [
      { id: 'flights', name: 'Commercial Flights', source: 'adsb.lol' },
      { id: 'military', name: 'Military Flights', source: 'adsb.lol' },
    ],
  },
  {
    id: 'hazards',
    label: 'HAZARDS',
    layers: [
      { id: 'earthquakes', name: 'Earthquakes', source: 'USGS' },
      { id: 'firms', name: 'Fire Hotspots', source: 'NASA FIRMS VIIRS' },
      { id: 'weird', name: 'Odd source', source: 42 },
    ],
  },
];

const none = { query: '', onlyActive: false, activeLayers: {} };

describe('layerSearch', () => {
  it('no filter returns the input untouched', () => {
    expect(filterLayerSections(sections, none)).toBe(sections);
    expect(isLayerFilterActive(none)).toBe(false);
    expect(isLayerFilterActive({ query: '   ', onlyActive: false })).toBe(false);
  });

  it('matches by layer name, case-insensitive', () => {
    const out = filterLayerSections(sections, { ...none, query: 'MILITARY' });
    expect(out.map((s) => s.id)).toEqual(['aircraft']);
    expect(out[0].layers.map((l) => l.id)).toEqual(['military']);
  });

  it('matches by source text', () => {
    const out = filterLayerSections(sections, { ...none, query: 'usgs' });
    expect(out.flatMap((s) => s.layers.map((l) => l.id))).toEqual(['earthquakes']);
  });

  it('every token must match (AND)', () => {
    expect(filterLayerSections(sections, { ...none, query: 'nasa fire' })[0].layers.map((l) => l.id)).toEqual(['firms']);
    expect(filterLayerSections(sections, { ...none, query: 'nasa flights' })).toEqual([]);
  });

  it('section label matches all of its rows', () => {
    const out = filterLayerSections(sections, { ...none, query: 'hazards' });
    expect(out[0].layers).toHaveLength(3);
  });

  it('non-string sources are ignored, not crashed on', () => {
    expect(filterLayerSections(sections, { ...none, query: '42' })).toEqual([]);
  });

  it('only-active keeps switched-on layers, and combines with the query', () => {
    const activeLayers = { flights: true, military: false, earthquakes: true };
    const active = filterLayerSections(sections, { query: '', onlyActive: true, activeLayers });
    expect(active.flatMap((s) => s.layers.map((l) => l.id))).toEqual(['flights', 'earthquakes']);
    const both = filterLayerSections(sections, { query: 'quake', onlyActive: true, activeLayers });
    expect(both.flatMap((s) => s.layers.map((l) => l.id))).toEqual(['earthquakes']);
  });

  it('tokenizes on whitespace', () => {
    expect(tokenizeLayerQuery('  Fire   NASA ')).toEqual(['fire', 'nasa']);
  });
});
