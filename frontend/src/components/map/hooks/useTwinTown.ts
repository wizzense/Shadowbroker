'use client';

/**
 * AitherOS Digital Twin Town for the area on screen.
 *
 * Follows the visible view exactly like `useCivicLayers`: one request per area
 * (the resolved county when known, else the civic lat/lng circle), refetched
 * only when that area changes, debounced after a pan or a fly-to. A 202
 * {"status":"warming"} answer means the upstream is preparing the area: the
 * chip says so and the hook retries with backoff (5 s doubling, capped at
 * 30 s) for at most 5 minutes, then gives up until the view moves.
 */

import { useEffect, useRef, useState } from 'react';
import type { ActiveLayers } from '@/types/dashboard';
import { getVisibleViewBounds } from '@/lib/liveDataViewport';
import { VIEWPORT_COMMITTED_EVENT, VISIBLE_VIEW_EVENT } from '@/components/map/hooks/useViewportBounds';
import {
  sanitizeTwinTown,
  setTwinTownStatus,
  TWIN_WARMING_GIVE_UP_MS,
  twinTownAreaFromBounds,
  twinTownAreaKey,
  twinTownUrl,
  twinWarmingDelayMs,
  type TwinTownData,
  type TwinTownLayerKey,
} from '@/lib/twinTown';

export type TwinTownState = {
  data: TwinTownData | null;
  loading: boolean;
  warming: boolean;
  error: string | null;
};

const EMPTY: TwinTownState = { data: null, loading: false, warming: false, error: null };
const VIEWPORT_REFETCH_DEBOUNCE_MS = 1200;

export function useTwinTown(activeLayers: Pick<ActiveLayers, TwinTownLayerKey>): TwinTownState {
  const [state, setState] = useState<TwinTownState>(EMPTY);
  const areaKeyRef = useRef<string | null>(null);
  const enabled = !!(activeLayers.twin_town || activeLayers.twin_town_news);

  useEffect(() => {
    if (!enabled) {
      areaKeyRef.current = null;
      setState(EMPTY);
      setTwinTownStatus({ phase: 'off' });
      return;
    }

    let cancelled = false;
    let controller: AbortController | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const fetchArea = async (url: string, attempt: number, startedAt: number, signal: AbortSignal) => {
      try {
        const res = await fetch(url, { signal, headers: { Accept: 'application/geo+json, application/json' } });
        if (cancelled || signal.aborted) return;
        if (res.status === 202) {
          if (Date.now() - startedAt >= TWIN_WARMING_GIVE_UP_MS) {
            const message = 'Twin town is not ready for this area yet.';
            setState((prev) => ({ ...prev, loading: false, warming: false, error: message }));
            setTwinTownStatus({ phase: 'unavailable', message });
            // The next view change may try again.
            areaKeyRef.current = null;
            return;
          }
          setState((prev) => ({ ...prev, loading: false, warming: true, error: null }));
          setTwinTownStatus({ phase: 'warming' });
          retry = setTimeout(() => void fetchArea(url, attempt + 1, startedAt, signal), twinWarmingDelayMs(attempt));
          return;
        }
        if (!res.ok) throw new Error(`twin town ${res.status}`);
        const data = sanitizeTwinTown(await res.json());
        if (cancelled || signal.aborted) return;
        if (!data) throw new Error('twin town answer malformed');
        setState({ data, loading: false, warming: false, error: null });
        setTwinTownStatus({ phase: 'ready', town: data.town });
      } catch {
        if (cancelled || signal.aborted) return;
        const message = 'Twin town unavailable';
        setState((prev) => ({ ...prev, loading: false, warming: false, error: message }));
        setTwinTownStatus({ phase: 'unavailable', message });
        areaKeyRef.current = null;
      }
    };

    const load = () => {
      const area = twinTownAreaFromBounds(getVisibleViewBounds());
      const key = twinTownAreaKey(area);
      if (key === areaKeyRef.current) return;
      areaKeyRef.current = key;
      controller?.abort();
      if (retry) clearTimeout(retry);
      controller = new AbortController();
      setState((prev) => ({ ...prev, loading: true, error: null }));
      setTwinTownStatus({ phase: 'loading' });
      void fetchArea(twinTownUrl(area), 0, Date.now(), controller.signal);
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
      if (retry) clearTimeout(retry);
      areaKeyRef.current = null;
      window.removeEventListener(VIEWPORT_COMMITTED_EVENT, onViewport);
      window.removeEventListener(VISIBLE_VIEW_EVENT, onViewport);
    };
  }, [enabled]);

  return state;
}
