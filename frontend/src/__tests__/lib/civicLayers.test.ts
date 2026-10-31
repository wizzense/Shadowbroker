import { describe, expect, it } from 'vitest';
import {
  buildCivicProjectsGeoJSON,
  CIVIC_ENTITY_TYPE,
  sanitizeCivicPoints,
} from '@/lib/civicLayers';

// The map click handler only selects a feature that carries `type` and `id`,
// and the civic popup anchors on `lat`/`lng`. Without them the ALPR, civic
// data-center and federal-project dots render but cannot be clicked.
describe('civic layers are selectable', () => {
  const raw = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-118.25, 34.05] },
        properties: { name: 'Flock cam', operator: 'LAPD', make: 'Flock Safety' },
      },
      { type: 'Feature', geometry: { type: 'Point', coordinates: ['bad', 1] }, properties: {} },
    ],
  };

  it('tags ALPR points with type, unique id and coordinates', () => {
    const fc = sanitizeCivicPoints(raw, 100, CIVIC_ENTITY_TYPE.alpr);
    expect(fc?.features).toHaveLength(1);
    const p = fc!.features[0].properties as Record<string, unknown>;
    expect(p.type).toBe('civic_alpr');
    expect(p.id).toBe('civic_alpr-0');
    expect(p.lat).toBe(34.05);
    expect(p.lng).toBe(-118.25);
    expect(p.operator).toBe('LAPD');
  });

  it('tags data-center points with their own type', () => {
    const fc = sanitizeCivicPoints(raw, 100, CIVIC_ENTITY_TYPE.datacenters);
    expect((fc!.features[0].properties as Record<string, unknown>).type).toBe('civic_datacenter');
  });

  it('tags the federal projects pin', () => {
    const fc = buildCivicProjectsGeoJSON(
      { construction_contracts: { total: 1000, top: [{ recipient: 'ACME', amount: 1000 }] } },
      { lat: 34, lng: -118, radius_km: 50 },
    );
    const p = fc!.features[0].properties as Record<string, unknown>;
    expect(p.type).toBe('civic_project');
    expect(typeof p.id).toBe('string');
    expect(p.lat).toBe(34);
    expect(p.lng).toBe(-118);
  });
});
