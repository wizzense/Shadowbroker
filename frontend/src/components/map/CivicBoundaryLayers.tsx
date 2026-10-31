'use client';

/**
 * District boundary overlays for the AitherOS Civic Atlas. One source per
 * left-panel toggle: a near-transparent fill (what the click lands on), a line,
 * and a name label once zoomed in. Clicking a fill asks "who represents here"
 * for that point (see `civicLookupFromMapClick`).
 */

import React from 'react';
import { Layer, Source } from 'react-map-gl/maplibre';
import {
  CIVIC_BOUNDARY_STYLE,
  CIVIC_BOUNDARY_TOGGLE_KEYS,
  civicBoundaryFillId,
  civicBoundaryLineId,
  type CivicBoundaryToggle,
} from '@/lib/civicDirectory';
import type { CivicBoundariesState } from '@/components/map/hooks/useCivicBoundaries';

/** Interactive layer ids for the boundaries currently drawn. */
export function civicBoundaryInteractiveIds(state: CivicBoundariesState): string[] {
  return CIVIC_BOUNDARY_TOGGLE_KEYS.filter((k) => state.layers[k]?.features.length).map(civicBoundaryFillId);
}

function BoundarySource({ toggle, data }: { toggle: CivicBoundaryToggle; data: GeoJSON.FeatureCollection }) {
  const style = CIVIC_BOUNDARY_STYLE[toggle];
  return (
    <Source id={`civic-boundary-${toggle}-source`} type="geojson" data={data}>
      <Layer
        id={civicBoundaryFillId(toggle)}
        type="fill"
        paint={{ 'fill-color': style.color, 'fill-opacity': 0.04 }}
      />
      <Layer
        id={civicBoundaryLineId(toggle)}
        type="line"
        paint={{
          'line-color': style.color,
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.6, 9, 1.6],
          'line-opacity': 0.85,
          ...(style.dash ? { 'line-dasharray': style.dash } : {}),
        }}
      />
      <Layer
        id={`civic-boundary-${toggle}-label`}
        type="symbol"
        minzoom={7}
        layout={{
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 10,
          'text-allow-overlap': false,
        }}
        paint={{ 'text-color': style.color, 'text-halo-color': 'rgba(0,0,0,0.9)', 'text-halo-width': 1 }}
      />
    </Source>
  );
}

export default function CivicBoundaryLayers({ state }: { state: CivicBoundariesState }) {
  return (
    <>
      {CIVIC_BOUNDARY_TOGGLE_KEYS.map((k) => {
        const fc = state.layers[k];
        return fc && fc.features.length ? <BoundarySource key={k} toggle={k} data={fc} /> : null;
      })}
    </>
  );
}
