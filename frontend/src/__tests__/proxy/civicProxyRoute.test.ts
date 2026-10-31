import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type RouteModule = typeof import('@/app/api/civic-proxy/[...path]/route');

async function freshRoute(): Promise<RouteModule> {
  vi.resetModules();
  return import('@/app/api/civic-proxy/[...path]/route');
}

function call(mod: RouteModule, path: string[], query = '') {
  const req = new NextRequest(`http://localhost/api/civic-proxy/${path.join('/')}${query ? `?${query}` : ''}`);
  return mod.GET(req, { params: Promise.resolve({ path }) });
}

describe('civic proxy route', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    process.env.CIVIC_API_BASE = 'https://civic.test/api/civic';
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CIVIC_API_BASE;
  });

  it('forwards an allowed route with only validated params, then serves it from cache', async () => {
    const mod = await freshRoute();
    fetchMock.mockResolvedValue(new Response('{"matched":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const first = await call(mod, ['lookup'], 'lat=39.10234&lng=-84.51&address=secret');
    expect(first.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://civic.test/api/civic/lookup?lat=39.102&lng=-84.510');
    const second = await call(mod, ['lookup'], 'lat=39.1024&lng=-84.51');
    expect(second.headers.get('X-Civic-Cache')).toBe('fresh');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a route off the allowlist without touching the upstream', async () => {
    const mod = await freshRoute();
    expect((await call(mod, ['p2025', 'search'], 'q=x')).status).toBe(404);
    expect((await call(mod, ['units'], 'state=XX')).status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes a "not loaded" 503 through and cools down only that route kind', async () => {
    const mod = await freshRoute();
    fetchMock.mockResolvedValueOnce(new Response('{"detail":"not loaded"}', { status: 503 }));
    expect((await call(mod, ['units'], 'state=OH&county=061')).status).toBe(503);
    // Same kind: cooling down, no upstream call.
    expect((await call(mod, ['units'], 'state=OH')).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Another kind still reaches upstream.
    fetchMock.mockResolvedValueOnce(new Response('{"state":"Ohio","actions":[]}', { status: 200 }));
    expect((await call(mod, ['how-to-vote', 'OH'])).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps an unexpected upstream failure to 502', async () => {
    const mod = await freshRoute();
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    expect((await call(mod, ['elections'], 'state=OH')).status).toBe(502);
  });
});
