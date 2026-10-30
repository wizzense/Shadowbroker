'use client';

/**
 * AitherOS Civic Atlas layers: license-plate readers, data centers, federal
 * construction spending.
 *
 * The upstream API is area-scoped, so the hook follows the map: it resolves the
 * committed viewport to a lat/lng circle (the API caps the radius at 50 km) and
 * refetches only when that area actually changes. `/api/civic-proxy/*` answers
 * server-side, which keeps the browser off aitherium.com (no CORS) and lets one
 * cached lookup serve every viewer.
 */

import { useEffect, useRef, useState } from 'react';
import type { ActiveLayers } from '@/types/dashboard';
import { getLiveDataBounds } from '@/lib/liveDataViewport';
import { VIEWPORT_COMMITTED_EVENT } from '@/components/map/hooks/useViewportBounds';
import {
  buildCivicProjectsGeoJSON,
  civicLayerUrl,
  civicQueryFromBounds,
  civicQueryKey,
  sanitizeCivicPoints,
  type CivicLayerKey,
  type CivicProjectsAnswer,
  type CivicQuery,
} from '@/lib/civicLayers';

type CivicGeoJSON = GeoJSON.FeatureCollection<GeoJSON.Point> | null;

export type CivicLayersState = {
  alpr: CivicGeoJSON;
  datacenters: CivicGeoJSON;
  projects: CivicGeoJSON;
  area: CivicQuery;
  loading: boolean;
  error: string | null;
};

const EMPTY_STATE: CivicLayersState = {
  alpr: null,
  datacenters: null,
  projects: null,
  area: { lat: 0, lng: 0, radius_km: 0 },
  loading: false,
  error: null,
};

const VIEWPORT_REFETCH_DEBOUNCE_MS = 1200;

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`civic ${res.status}`);
  return res.json();
}

export function useCivicLayers(activeLayers: Pick<ActiveLayers, CivicLayerKey>): CivicLayersState {
  const [state, setState] = useState<CivicLayersState>(EMPTY_STATE);
  const queryKeyRef = useRef<string | null>(null);

  const enabled = activeLayers.civic_alpr || activeLayers.civic_datacenters || activeLayers.civic_projects;

  useEffect(() => {
    if (!enabled) {
      queryKeyRef.current = null;
      setState(EMPTY_STATE);
      return;
    }

    let cancelled = false;
    let controller: AbortController | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const load = () => {
      const query = civicQueryFromBounds(getLiveDataBounds());
      const key = civicQueryKey(query);
      if (key === queryKeyRef.current) return;
      queryKeyRef.current = key;

      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      setState((prev) => ({ ...prev, loading: true, error: null, area: query }));

      const jobs: Array<Promise<void>> = [];
      if (activeLayers.civic_alpr) {
        jobs.push(
          fetchJson(civicLayerUrl('civic_alpr', query), signal)
            .then((raw) => {
              if (cancelled) return;
              setState((prev) => ({ ...prev, alpr: sanitizeCivicPoints(raw) }));
            })
            .catch(() => undefined),
        );
      } else {
        setState((prev) => ({ ...prev, alpr: null }));
      }
      if (activeLayers.civic_datacenters) {
        jobs.push(
          fetchJson(civicLayerUrl('civic_datacenters', query), signal)
            .then((raw) => {
              if (cancelled) return;
              setState((prev) => ({ ...prev, datacenters: sanitizeCivicPoints(raw) }));
            })
            .catch(() => undefined),
        );
      } else {
        setState((prev) => ({ ...prev, datacenters: null }));
      }
      if (activeLayers.civic_projects) {
        jobs.push(
          fetchJson(civicLayerUrl('civic_projects', query), signal)
            .then((raw) => {
              if (cancelled) return;
              setState((prev) => ({
                ...prev,
                projects: buildCivicProjectsGeoJSON(raw as CivicProjectsAnswer, query),
              }));
            })
            .catch(() => undefined),
        );
      } else {
        setState((prev) => ({ ...prev, projects: null }));
      }

      void Promise.all(jobs)
        .then(() => {
          if (cancelled) return;
          setState((prev) => (prev.loading ? { ...prev, loading: false } : prev));
        })
        .catch(() => {
          if (cancelled) return;
          setState((prev) => ({ ...prev, loading: false, error: 'Civic layers unavailable' }));
        });
    };

    const onViewport = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(load, VIEWPORT_REFETCH_DEBOUNCE_MS);
    };

    load();
    window.addEventListener(VIEWPORT_COMMITTED_EVENT, onViewport);
    return () => {
      cancelled = true;
      controller?.abort();
      if (debounce) clearTimeout(debounce);
      window.removeEventListener(VIEWPORT_COMMITTED_EVENT, onViewport);
    };
  }, [
    enabled,
    activeLayers.civic_alpr,
    activeLayers.civic_datacenters,
    activeLayers.civic_projects,
  ]);

  return state;
}
