import { describe, expect, it, vi } from 'vitest';
import { createShadowbrokerTools, ToolRegistry, type ToolContext } from '@/lib/webmcp';

function registry(fetchJson: ToolContext['fetchJson']) {
  const ctx: ToolContext = {
    readStore: () => ({}),
    getBounds: () => null,
    getActiveLayers: () => ({}),
    map: { flyTo: vi.fn(), setLayer: vi.fn() },
    fetchJson,
  };
  return new ToolRegistry(createShadowbrokerTools(), ctx);
}

const LIST = {
  candidates: [
    { id: 'fec:H2OH01194', name: 'Greg Landsman', party: 'DEMOCRATIC PARTY', status: 'Incumbent', district: '1',
      money: { receipts: 10 }, has_campaign_site: false, links: [{ kind: 'fec', url: 'https://www.fec.gov/data/candidate/H2OH01194/' }] },
  ],
  notes: ['FEC registration is not ballot status.'],
  source: { name: 'OpenFEC' },
};

describe('candidate tools', () => {
  it('get_candidates asks this app for House and Senate and returns ids the page tool accepts', async () => {
    const fetchJson = vi.fn(async () => LIST);
    const r = await registry(fetchJson).call('get_candidates', { state: 'Ohio' });
    expect(r.ok).toBe(true);
    const urls = fetchJson.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(urls).toEqual([
      expect.stringMatching(/^\/api\/civic-candidates\/federal\?state=OH&office=H(&cycle=\d+)?$/),
      expect.stringMatching(/^\/api\/civic-candidates\/federal\?state=OH&office=S(&cycle=\d+)?$/),
    ]);
    const res = r.result as { races: Array<{ candidates: Array<{ candidate_id: string; fec_url: string }> }>; state_local: string };
    expect(res.races[0].candidates[0]).toMatchObject({ candidate_id: 'fec:H2OH01194', fec_url: 'https://www.fec.gov/data/candidate/H2OH01194/' });
    expect(res.state_local).toMatch(/not available/);
  });

  it('get_candidates with a district asks only for that House race', async () => {
    const fetchJson = vi.fn(async () => LIST);
    await registry(fetchJson).call('get_candidates', { state: 'OH', district: '1' });
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(String((fetchJson.mock.calls[0] as unknown[])[0])).toContain('office=H&district=01');
    expect((await registry(fetchJson).call('get_candidates', { state: 'OH', office: 'governor' })).ok).toBe(false);
    expect((await registry(fetchJson).call('get_candidates', { state: 'Atlantis' })).ok).toBe(false);
  });

  it('get_candidate_page only takes a candidate id, never a URL', async () => {
    const fetchJson = vi.fn(async () => ({ ok: true, final_url: 'https://landsmanforcongress.com/', page: { text: 'plan' } }));
    const reg = registry(fetchJson);
    const r = await reg.call('get_candidate_page', { candidate_id: 'fec:H2OH01194' });
    expect(r.ok).toBe(true);
    expect(fetchJson).toHaveBeenCalledWith('/api/civic-candidates/page?id=fec%3AH2OH01194', undefined);
    const bad = await reg.call('get_candidate_page', { candidate_id: 'https://evil.example/' });
    expect(bad.ok).toBe(false);
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it('both tools are read-only', () => {
    const tools = createShadowbrokerTools().filter((t) => t.name === 'get_candidates' || t.name === 'get_candidate_page');
    expect(tools.map((t) => [t.name, t.readOnly])).toEqual([['get_candidates', true], ['get_candidate_page', true]]);
  });
});
