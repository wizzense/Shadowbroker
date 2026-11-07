import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTwinTown } from '@/components/map/hooks/useTwinTown';
import { announceViewTarget } from '@/components/map/hooks/useViewportBounds';
import { setVisibleViewBounds } from '@/lib/liveDataViewport';
import { getTwinTownStatus, setResolvedTwinCounty, TWIN_WARMING_GIVE_UP_MS } from '@/lib/twinTown';

const TOWN = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-84.5, 39.1] },
      properties: { layer: 'twin-town', kind: 'cafe', name: 'Cafe', open: true, twins_here: 4, meetings_hour: 1, hour: 9 },
    },
  ],
  town: {
    id: 't',
    name: 'Twinford',
    county_fips: '39061',
    residents: 900,
    synthetic: true,
    as_of: '2026-11-06T09:00:00Z',
    cache_age_s: 0,
  },
});
const WARMING = () => new Response('{"status":"warming"}', { status: 202 });

function urls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0]));
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useTwinTown', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibleViewBounds(null);
    setResolvedTwinCounty(null);
    fetchMock = vi.fn(async () => new Response(TOWN, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setVisibleViewBounds(null);
    setResolvedTwinCounty(null);
  });

  it('fetches nothing while both toggles are off', async () => {
    renderHook(() => useTwinTown({ twin_town: false, twin_town_news: false }));
    await tick(2000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getTwinTownStatus().phase).toBe('off');
  });

  it('asks the proxy for the area in view and follows a fly-to', async () => {
    const { result } = renderHook(() => useTwinTown({ twin_town: true, twin_town_news: false }));
    await tick(0);
    expect(urls(fetchMock)[0]).toBe('/api/civic-proxy/town?lat=38.9072&lng=-77.0369&radius_km=50&format=geojson');
    expect(result.current.data?.venues.features).toHaveLength(1);
    expect(getTwinTownStatus()).toMatchObject({ phase: 'ready', town: { name: 'Twinford', synthetic: true } });

    act(() => announceViewTarget({ south: 39.0, west: -84.6, north: 39.2, east: -84.4 }));
    await tick(1500);
    expect(urls(fetchMock).at(-1)).toBe('/api/civic-proxy/town?lat=39.1&lng=-84.5&radius_km=14&format=geojson');
  });

  it('on 202 warming shows the warming state and retries with backoff, then succeeds', async () => {
    fetchMock.mockImplementationOnce(async () => WARMING()).mockImplementationOnce(async () => WARMING());
    const { result } = renderHook(() => useTwinTown({ twin_town: true, twin_town_news: true }));
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.warming).toBe(true);
    expect(getTwinTownStatus().phase).toBe('warming');
    await tick(4900);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await tick(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The second wait is 10 s.
    await tick(10000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.warming).toBe(false);
    expect(result.current.data?.town?.name).toBe('Twinford');
    expect(getTwinTownStatus().phase).toBe('ready');
  });

  it('never retries faster than every 30 s apart at the cap and gives up after 5 minutes', async () => {
    fetchMock.mockImplementation(async () => WARMING());
    const { result } = renderHook(() => useTwinTown({ twin_town: true, twin_town_news: false }));
    await tick(0);
    const callTimes: number[] = [0];
    let seen = 1;
    for (let t = 1000; t <= TWIN_WARMING_GIVE_UP_MS + 120000; t += 1000) {
      await tick(1000);
      if (fetchMock.mock.calls.length !== seen) {
        seen = fetchMock.mock.calls.length;
        callTimes.push(t);
      }
    }
    const gaps = callTimes.slice(1).map((v, i) => v - callTimes[i]);
    expect(gaps.slice(0, 3)).toEqual([5000, 10000, 20000]);
    expect(gaps.slice(3).every((g) => g === 30000)).toBe(true);
    // Stopped within one retry interval of the 5-minute mark, and says so.
    expect(callTimes.at(-1)!).toBeLessThanOrEqual(TWIN_WARMING_GIVE_UP_MS + 30000);
    expect(result.current.warming).toBe(false);
    expect(result.current.error).toMatch(/not ready/);
    expect(getTwinTownStatus().phase).toBe('unavailable');
  });
});
