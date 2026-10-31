import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const fetchCampaignPage = vi.fn();
vi.mock('@/lib/server/campaignPage', () => ({ fetchCampaignPage: (...a: unknown[]) => fetchCampaignPage(...a) }));

type RouteModule = typeof import('@/app/api/civic-candidates/[...path]/route');

async function freshRoute(): Promise<RouteModule> {
  vi.resetModules();
  return import('@/app/api/civic-candidates/[...path]/route');
}

async function call(mod: RouteModule, seg: string, query = '') {
  const req = new NextRequest(`http://localhost/api/civic-candidates/${seg}${query ? `?${query}` : ''}`);
  const res = await mod.GET(req, { params: Promise.resolve({ path: [seg] }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('civic candidates route', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    delete process.env.FEC_API_KEY;
    delete process.env.GOOGLE_CIVIC_API_KEY;
    fetchMock.mockReset();
    fetchCampaignPage.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('federal: DEMO_KEY when FEC_API_KEY is unset, says so, caches the race', async () => {
    const mod = await freshRoute();
    fetchMock.mockResolvedValue(ok({ results: [{ candidate_id: 'H2OH01194', name: 'LANDSMAN, GREG', incumbent_challenge: 'I', office: 'H', state: 'OH', district: '01', receipts: 10 }] }));
    const a = await call(mod, 'federal', 'state=OH&office=H&district=1&cycle=2026');
    expect(a.status).toBe(200);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toMatch(/^https:\/\/api\.open\.fec\.gov\/v1\/candidates\/totals\/\?api_key=DEMO_KEY&/);
    expect(url).toContain('district=01');
    expect(a.body.rate_limited).toBe(true);
    expect((a.body.notes as string[]).join(' ')).toMatch(/DEMO_KEY/);
    expect(JSON.stringify(a.body)).not.toContain('api_key');
    await call(mod, 'federal', 'state=OH&office=H&district=1&cycle=2026');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('federal: uses FEC_API_KEY from env and never returns it', async () => {
    process.env.FEC_API_KEY = 'fec-test-key-123';
    const mod = await freshRoute();
    fetchMock.mockResolvedValue(ok({ results: [] }));
    const a = await call(mod, 'federal', 'state=OH&office=S&cycle=2026');
    expect(String(fetchMock.mock.calls[0][0])).toContain('api_key=fec-test-key-123');
    expect(JSON.stringify(a.body)).not.toContain('fec-test-key-123');
    expect(a.body.rate_limited).toBe(false);
  });

  it('page: resolves the URL from the FEC committee record, never from the caller', async () => {
    const mod = await freshRoute();
    fetchMock.mockResolvedValue(ok({ results: [{ designation: 'P', website: 'LANDSMANFORCONGRESS.COM' }] }));
    fetchCampaignPage.mockResolvedValue({ ok: true, url: 'https://landsmanforcongress.com/', final_url: 'https://landsmanforcongress.com/', page: { text: 'x' } });
    const r = await call(mod, 'page', 'id=fec:H2OH01194&url=https://evil.example/');
    expect(r.status).toBe(200);
    expect(fetchCampaignPage).toHaveBeenCalledWith('https://landsmanforcongress.com/');
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/candidate\/H2OH01194\/committees\/\?/);
    expect((await call(mod, 'page', 'id=https://evil.example/')).status).toBe(422);
    expect((await call(mod, 'page', 'id=gc:0123456789abcdef')).status).toBe(404);
  });

  it('page: says plainly when the record names no website', async () => {
    const mod = await freshRoute();
    fetchMock.mockResolvedValue(ok({ results: [{ designation: 'P', website: null }] }));
    const r = await call(mod, 'page', 'id=fec:H6OH01195');
    expect(r.body).toMatchObject({ ok: false, error: 'The source record lists no campaign website for this candidate.' });
    expect(fetchCampaignPage).not.toHaveBeenCalled();
  });

  it('ballot: 501 without GOOGLE_CIVIC_API_KEY — no invented list', async () => {
    const mod = await freshRoute();
    const r = await call(mod, 'ballot', 'address=1 Main St, Cincinnati OH');
    expect(r.status).toBe(501);
    expect(String(r.body.message)).toMatch(/not available yet/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('status reports configuration as booleans only', async () => {
    process.env.FEC_API_KEY = 'secret-value';
    const mod = await freshRoute();
    const r = await call(mod, 'status');
    expect(r.body).toMatchObject({ fec: { configured: true }, google_civic: { configured: false } });
    expect(JSON.stringify(r.body)).not.toContain('secret-value');
    expect((await call(mod, 'nope')).status).toBe(404);
  });
});
