'use client';

/**
 * AitherOS Civic Atlas district boundaries (congressional, state legislative,
 * school district, county, place) for the state(s) at the centre of the view.
 *
 * Upstream serves one whole state per layer (TIGERweb, simplified to ~1 km), so
 * the hook only refetches when the state under the view centre changes, never
 * on a pan inside it. Up to two states load at once so a view straddling a
 * border draws both sides. Zoomed out past a few states, nothing loads: a
 * national view of every school district is noise, and each state layer costs
 * a request against the upstream anonymous quota.
 */

import { useEffect, useRef, useState } from 'react';
import type { ActiveLayers } from '@/types/dashboard';
import { getVisibleViewBounds } from '@/lib/liveDataViewport';
import { VIEWPORT_COMMITTED_EVENT, VISIBLE_VIEW_EVENT } from '@/components/map/hooks/useViewportBounds';
import { setCivicCoverage } from '@/lib/civicLayers';
import {
  CIVIC_BOUNDARY_TOGGLES,
  CIVIC_BOUNDARY_TOGGLE_KEYS,
  civicBoundaryUrl,
  sanitizeCivicBoundaries,
  statesForPoint,
  type CivicBoundaryLayer,
  type CivicBoundaryMeta,
  type CivicBoundaryToggle,
} from '@/lib/civicDirectory';

type PolyFC = GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>;

export type CivicBoundariesState = {
  layers: Partial<Record<CivicBoundaryToggle, PolyFC>>;
  states: string[];
  meta: CivicBoundaryMeta[];
  loading: boolean;
  /** Human-readable reason nothing is drawn (zoomed out, outside the US, upstream down). */
  note: string | null;
};

const EMPTY: CivicBoundariesState = { layers: {}, states: [], meta: [], loading: false, note: null };
/** Latitude span above which the view covers too many states to draw district lines. */
export const CIVIC_BOUNDARY_MAX_LAT_SPAN = 12;
const MAX_STATES = 2;
const DEBOUNCE_MS = 900;

/** Survives toggling a layer off and on; one state layer is fetched once per session. */
const memo = new Map<string, { fc: PolyFC; meta: CivicBoundaryMeta } | null>();
const MEMO_MAX = 40;

async function loadLayer(layer: CivicBoundaryLayer, state: string, signal: AbortSignal) {
  const url = civicBoundaryUrl(layer, state);
  if (memo.has(url)) return memo.get(url) ?? null;
  const res = await fetch(url, { signal, headers: { Accept: 'application/geojson, application/json' } });
  if (!res.ok) {
    // 404/422 are permanent for this state+layer (e.g. no elementary districts there).
    if (res.status === 404 || res.status === 422) memo.set(url, null);
    throw new Error(`civic boundary ${res.status}`);
  }
  const parsed = sanitizeCivicBoundaries(await res.json());
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value as string);
  memo.set(url, parsed);
  return parsed;
}

function viewStates(): { states: string[]; note: string | null } {
  // The VISIBLE view: the live-data preload window is padded to a 3,000-mile
  // radius and would always read as "zoomed out".
  const b = getVisibleViewBounds();
  if (!b) return { states: [], note: null };
  if (Math.abs(b.north - b.south) > CIVIC_BOUNDARY_MAX_LAT_SPAN) {
    return { states: [], note: 'Zoom in to a state to draw district lines.' };
  }
  const lat = (b.north + b.south) / 2;
  let lngSpan = b.east - b.west;
  if (lngSpan < 0) lngSpan += 360;
  const lng = ((b.west + lngSpan / 2 + 540) % 360) - 180;
  const states = statesForPoint(lat, lng).slice(0, MAX_STATES);
  return { states, note: states.length ? null : 'District lines cover US states and territories only.' };
}

export function useCivicBoundaries(activeLayers: Pick<ActiveLayers, CivicBoundaryToggle>): CivicBoundariesState {
  const [state, setState] = useState<CivicBoundariesState>(EMPTY);
  const keyRef = useRef<string | null>(null);
  const enabled = CIVIC_BOUNDARY_TOGGLE_KEYS.filter((k) => activeLayers[k]);
  const enabledKey = enabled.join(',');

  useEffect(() => {
    if (!enabledKey) {
      keyRef.current = null;
      setState(EMPTY);
      setCivicCoverage('boundaries', null);
      return;
    }
    const toggles = enabledKey.split(',') as CivicBoundaryToggle[];
    let cancelled = false;
    let controller: AbortController | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const load = () => {
      const { states, note } = viewStates();
      const key = `${enabledKey}|${states.join(',')}`;
      if (key === keyRef.current) return;
      keyRef.current = key;
      controller?.abort();
      if (!states.length) {
        setState({ ...EMPTY, note });
        setCivicCoverage('boundaries', note);
        return;
      }
      setCivicCoverage('boundaries', `${states.join(', ')} · loading…`);
      controller = new AbortController();
      const signal = controller.signal;
      setState((prev) => ({ ...prev, states, loading: true, note: null }));

      const jobs = toggles.map(async (toggle) => {
        const parts = await Promise.all(
          CIVIC_BOUNDARY_TOGGLES[toggle].flatMap((layer) =>
            states.map((st) => loadLayer(layer, st, signal).catch(() => null)),
          ),
        );
        const ok = parts.filter((p): p is NonNullable<typeof p> => !!p);
        const fc: PolyFC = { type: 'FeatureCollection', features: ok.flatMap((p) => p.fc.features) };
        return { toggle, fc, meta: ok.map((p) => p.meta), failed: parts.length - ok.length };
      });

      void Promise.all(jobs).then((results) => {
        if (cancelled || signal.aborted) return;
        const layers: CivicBoundariesState['layers'] = {};
        for (const r of results) if (r.fc.features.length) layers[r.toggle] = r.fc;
        const failed = results.reduce((n, r) => n + r.failed, 0);
        const drawn = results.some((r) => r.fc.features.length);
        setState({
          layers,
          states,
          meta: results.flatMap((r) => r.meta),
          loading: false,
          note: !drawn && failed ? 'Civic boundary service unavailable; retrying on the next move.' : null,
        });
        setCivicCoverage(
          'boundaries',
          drawn ? `${states.join(', ')}${failed ? ` · ${failed} layer(s) unavailable` : ''}` : `${states.join(', ')} · unavailable`,
        );
        // Let a later viewport event retry what failed instead of pinning the miss.
        if (failed && !drawn) keyRef.current = null;
      });
    };

    const onViewport = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(load, DEBOUNCE_MS);
    };

    load();
    window.addEventListener(VIEWPORT_COMMITTED_EVENT, onViewport);
    window.addEventListener(VISIBLE_VIEW_EVENT, onViewport);
    return () => {
      cancelled = true;
      controller?.abort();
      if (debounce) clearTimeout(debounce);
      window.removeEventListener(VIEWPORT_COMMITTED_EVENT, onViewport);
      window.removeEventListener(VISIBLE_VIEW_EVENT, onViewport);
    };
  }, [enabledKey]);

  return state;
}
