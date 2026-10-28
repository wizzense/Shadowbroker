import { describe, it, expect } from 'vitest';
import { splitAIIntelGeoJSON } from '@/components/map/geoJSONBuilders';

const point = (id: string, lng: number, lat: number) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lng, lat] },
  properties: { id, label: id, category: 'custom', color: '#3b82f6' },
});

const shape = (id: string, type: string, coordinates: unknown) => ({
  type: 'Feature',
  geometry: { type, coordinates },
  properties: { id, label: id, color: '#123456', kind: 'shape' },
});

const SQUARE = [
  [
    [-84.6, 39.0],
    [-84.4, 39.0],
    [-84.4, 39.2],
    [-84.6, 39.0],
  ],
];

describe('splitAIIntelGeoJSON', () => {
  it('maps Point features to pins exactly as before', () => {
    const { pins, shapes } = splitAIIntelGeoJSON({ features: [point('a', -84.5, 39.1)] });
    expect(pins).toEqual([
      { id: 'a', label: 'a', category: 'custom', color: '#3b82f6', lat: 39.1, lng: -84.5 },
    ]);
    expect(shapes).toBeNull();
  });

  it('collects polygon and line features into one collection, never into pins', () => {
    const { pins, shapes } = splitAIIntelGeoJSON({
      features: [
        point('office', -84.5, 39.1),
        shape('d1', 'Polygon', SQUARE),
        shape('d2', 'MultiPolygon', [SQUARE]),
        shape('r1', 'LineString', SQUARE[0]),
        shape('r2', 'MultiLineString', SQUARE),
      ],
    });
    expect(pins.map((p) => p.id)).toEqual(['office']);
    expect(shapes?.type).toBe('FeatureCollection');
    expect(shapes?.features.map((f) => f.properties?.id)).toEqual(['d1', 'd2', 'r1', 'r2']);
  });

  it('ignores other geometry types and malformed input', () => {
    expect(
      splitAIIntelGeoJSON({ features: [shape('x', 'GeometryCollection', []), { type: 'Feature' }, null] }),
    ).toEqual({ pins: [], shapes: null });
    expect(splitAIIntelGeoJSON(null)).toEqual({ pins: [], shapes: null });
    expect(splitAIIntelGeoJSON({ features: 'nope' })).toEqual({ pins: [], shapes: null });
  });
});
