import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCivicLayers } from '@/components/map/hooks/useCivicLayers';
import { announceViewTarget, VISIBLE_VIEW_EVENT } from '@/components/map/hooks/useViewportBounds';
import { estimateViewBounds, getVisibleViewBounds, setVisibleViewBounds } from '@/lib/liveDataViewport';
import { getCivicCoverage } from '@/lib/civicLayers';

const EMPTY_FC = JSON.stringify({ type: 'FeatureCollection', features: [] });

function urls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0]));
}

describe('useCivicLayers follows the visible view', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibleViewBounds(null);
    fetchMock = vi.fn(async () => new Response(EMPTY_FC, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setVisibleViewBounds(null);
  });

  it('refetches for the destination of a search-box fly-to, without waiting for moveend', async () => {
    const layers = { civic_alpr: true, civic_datacenters: false, civic_projects: false };
    renderHook(() => useCivicLayers(layers));
    // Before the map reports a view: the DC default.
    expect(urls(fetchMock)[0]).toContain('lat=38.9072&lng=-77.0369');

    // Search "34.05, -118.25" -> MaplibreViewer's fly-to effect announces the target.
    const events: string[] = [];
    window.addEventListener(VISIBLE_VIEW_EVENT, () => events.push('visible'));
    act(() => announceViewTarget(estimateViewBounds(34.05, -118.25, 11)));
    expect(events).toEqual(['visible']);
    expect(getVisibleViewBounds()?.south).toBeLessThan(34.05);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    const last = urls(fetchMock).at(-1)!;
    expect(last).toContain('lat=34.05');
    expect(last).toContain('lng=-118.25');

    // The default search zoom (8, ~380 km across) is wider than the circle: California state-wide.
    act(() => announceViewTarget(estimateViewBounds(34.05, -118.25, 8)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(urls(fetchMock).at(-1)).toBe('/api/civic-proxy/alpr?state=CA&format=geojson');
  });

  it('zoomed out over several states it queries each state and publishes the coverage', async () => {
    renderHook(() => useCivicLayers({ civic_alpr: true, civic_datacenters: false, civic_projects: false }));
    act(() => announceViewTarget({ south: 38.5, west: -85.5, north: 41.5, east: -80.0 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    const stateCalls = urls(fetchMock).filter((u) => /\/alpr\?state=[A-Z]{2}&format=geojson$/.test(u));
    expect(stateCalls[0]).toBe('/api/civic-proxy/alpr?state=OH&format=geojson');
    expect(stateCalls.length).toBeGreaterThanOrEqual(5);
    expect(getCivicCoverage().points).toMatch(/^OH, .*\(state-wide\)/);
  });
});
