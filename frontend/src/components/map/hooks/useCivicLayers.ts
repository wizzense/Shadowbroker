'use client';

/**
 * AitherOS Civic Atlas layers: license-plate readers, data centers, federal
 * construction spending.
 *
 * The upstream API is area-scoped: a lat/lng circle of at most 50 km, or a
 * whole state. The hook follows what is ON SCREEN (`getVisibleViewBounds`, not
 * the 3,000-mile preload window): zoomed in it asks for one circle; zoomed out
 * it asks for every state the view touches, nearest the centre first, capped
 * at CIVIC_MAX_STATES, and merges the answers. It refetches only when that area
 * actually changes, including right after a search-box / agent fly-to
 * (`announceViewTarget`). The loaded area is published for the left-panel
 * coverage badge.
 *
 * `/api/civic-proxy/*` answers server-side, which keeps the browser off
 * aitherium.com (no CORS) and lets one cached lookup serve every viewer.
 */

import { useEffect, useRef, useState } from 'react';
import type { ActiveLayers } from '@/types/dashboard';
import { getVisibleViewBounds } from '@/lib/liveDataViewport';
import { VIEWPORT_COMMITTED_EVENT, VISIBLE_VIEW_EVENT } from '@/components/map/hooks/useViewportBounds';
import {
  buildCivicProjectsGeoJSON,
  CIVIC_ENTITY_TYPE,
  civicAnswerTruncated,
  civicAreaFromBounds,
  civicAreaKey,
  civicAreaRequests,
  mergeCivicPoints,
  sanitizeCivicPoints,
  setCivicCoverage,
  type CivicArea,
  type CivicLayerKey,
  type CivicProjectsAnswer,
  type CivicQuery,
} from '@/lib/civicLayers';

type CivicGeoJSON = GeoJSON.FeatureCollection<GeoJSON.Point> | null;

export type CivicLayersState = {
  alpr: CivicGeoJSON;
  datacenters: CivicGeoJSON;
  projects: CivicGeoJSON;
  /** The circle queried, or the first state's anchor in state-wide mode. */
  area: CivicQuery;
  coverage: CivicArea | null;
  loading: boolean;
  error: string | null;
};

const EMPTY_STATE: CivicLayersState = {
  alpr: null,
  datacenters: null,
  projects: null,
  area: { lat: 0, lng: 0, radius_km: 0 },
  coverage: null,
  loading: false,
  error: null,
};

const VIEWPORT_REFETCH_DEBOUNCE_MS = 1200;

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`civic ${res.status}`);
  return res.json();
}

type PointLayer = 'civic_alpr' | 'civic_datacenters';

/** Fetch every request for a point layer; merge; note any upstream truncation. */
async function loadPoints(layer: PointLayer, area: CivicArea, signal: AbortSignal) {
  const entity = layer === 'civic_alpr' ? CIVIC_ENTITY_TYPE.alpr : CIVIC_ENTITY_TYPE.datacenters;
  const answers = await Promise.all(
    civicAreaRequests(layer, area).map((r) => fetchJson(r.url, signal).catch(() => null)),
  );
  const ok = answers.filter((a) => a !== null);
  if (!ok.length) throw new Error('civic layer unavailable');
  const truncated = ok.filter((a) => civicAnswerTruncated(a).truncated).length;
  return {
    fc: mergeCivicPoints(ok.map((a) => sanitizeCivicPoints(a, 20000, entity)), entity),
    truncated,
    failed: answers.length - ok.length,
  };
}

async function loadProjects(area: CivicArea, signal: AbortSignal) {
  const reqs = civicAreaRequests('civic_projects', area);
  const pins = await Promise.all(
    reqs.map((r) =>
      fetchJson(r.url, signal)
        .then((raw) => buildCivicProjectsGeoJSON(raw as CivicProjectsAnswer, r.anchor))
        .catch(() => null),
    ),
  );
  const features = pins.flatMap((p) => p?.features ?? []);
  return features.length ? ({ type: 'FeatureCollection', features } as GeoJSON.FeatureCollection<GeoJSON.Point>) : null;
}

export function useCivicLayers(activeLayers: Pick<ActiveLayers, CivicLayerKey>): CivicLayersState {
  const [state, setState] = useState<CivicLayersState>(EMPTY_STATE);
  const queryKeyRef = useRef<string | null>(null);

  const enabled = activeLayers.civic_alpr || activeLayers.civic_datacenters || activeLayers.civic_projects;

  useEffect(() => {
    if (!enabled) {
      queryKeyRef.current = null;
      setState(EMPTY_STATE);
      setCivicCoverage('points', null);
      return;
    }

    let cancelled = false;
    let controller: AbortController | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const load = () => {
      const area = civicAreaFromBounds(getVisibleViewBounds());
      const key = civicAreaKey(area);
      if (key === queryKeyRef.current) return;
      queryKeyRef.current = key;

      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      const anchor = area.kind === 'circle' ? area.query : civicAreaRequests('civic_projects', area)[0]?.anchor;
      setState((prev) => ({ ...prev, loading: true, error: null, coverage: area, area: anchor ?? prev.area }));
      setCivicCoverage('points', `${area.label} · loading…`);

      const notes: string[] = [];
      const jobs: Array<Promise<void>> = [];
      for (const layer of ['civic_alpr', 'civic_datacenters'] as const) {
        const slot = layer === 'civic_alpr' ? 'alpr' : 'datacenters';
        if (!activeLayers[layer]) {
          setState((prev) => ({ ...prev, [slot]: null }));
          continue;
        }
        jobs.push(
          loadPoints(layer, area, signal).then(({ fc, truncated, failed }) => {
            if (cancelled || signal.aborted) return;
            if (truncated) notes.push(`${slot}: ${truncated} area(s) capped upstream at 5,000 points`);
            if (failed) notes.push(`${slot}: ${failed} area(s) unavailable`);
            setState((prev) => ({ ...prev, [slot]: fc }));
          }),
        );
      }
      if (activeLayers.civic_projects) {
        jobs.push(
          loadProjects(area, signal).then((fc) => {
            if (cancelled || signal.aborted) return;
            setState((prev) => ({ ...prev, projects: fc }));
          }),
        );
      } else {
        setState((prev) => ({ ...prev, projects: null }));
      }

      void Promise.allSettled(jobs).then((results) => {
        if (cancelled || signal.aborted) return;
        const failed = results.filter((r) => r.status === 'rejected').length;
        const allFailed = results.length > 0 && failed === results.length;
        setState((prev) => ({ ...prev, loading: false, error: allFailed ? 'Civic layers unavailable' : null }));
        if (allFailed) {
          // Let the next view change retry rather than pinning the failure.
          queryKeyRef.current = null;
          setCivicCoverage('points', `${area.label} · unavailable`);
        } else {
          setCivicCoverage('points', notes.length ? `${area.label} · ${notes.join('; ')}` : area.label);
        }
      });
    };

    const onViewport = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(load, VIEWPORT_REFETCH_DEBOUNCE_MS);
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
  }, [
    enabled,
    activeLayers.civic_alpr,
    activeLayers.civic_datacenters,
    activeLayers.civic_projects,
  ]);

  return state;
}
