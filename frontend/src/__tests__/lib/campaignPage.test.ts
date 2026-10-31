// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  checkCampaignUrl,
  fetchCampaignPage,
  guardedLookup,
  htmlToText,
  isBlockedAddress,
  readCapped,
  type RawResponse,
  type Transport,
} from '@/lib/server/campaignPage';

function body(...chunks: string[]): AsyncIterable<Uint8Array> {
  return (async function* gen() {
    for (const c of chunks) yield Buffer.from(c);
  })();
}

function respond(partial: Partial<RawResponse>): RawResponse {
  return { status: 200, location: null, contentType: 'text/html; charset=utf-8', body: body(''), close: () => undefined, ...partial };
}

/** A transport scripted per URL; records what was dialled. */
function scripted(map: Record<string, Partial<RawResponse>>): { transport: Transport; dialled: string[] } {
  const dialled: string[] = [];
  return {
    dialled,
    transport: async (url) => {
      dialled.push(url.toString());
      const r = map[url.toString()];
      if (!r) throw new Error(`unexpected dial ${url}`);
      return respond(r);
    },
  };
}

describe('address policy', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:7f00:1::', 'ff02::1', 'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '172.32.0.1', '104.18.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it('allows only https public hostnames on 443', () => {
    expect(checkCampaignUrl('https://landsmanforcongress.com/').ok).toBe(true);
    for (const bad of [
      'http://landsmanforcongress.com/', 'ftp://x.com/', 'https://user:pw@x.com/', 'https://x.com:8443/',
      'https://localhost/', 'https://intranet/', 'https://127.0.0.1/', 'https://[::1]/', 'https://169.254.169.254/latest',
      'https://printer.local/', 'not a url',
    ]) {
      expect(checkCampaignUrl(bad).ok, bad).toBe(false);
    }
  });

  it('refuses a hostname that RESOLVES to a private address, at connect time', async () => {
    const lookup = guardedLookup((_host, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]));
    const err = await new Promise<NodeJS.ErrnoException | null>((r) => lookup('rebind.example', {}, (e) => r(e)));
    expect(err?.code).toBe('EBLOCKEDADDR');
    const ok = guardedLookup((_host, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]));
    const addr = await new Promise<string>((r) => ok('example.com', {}, (_e, a) => r(String(a))));
    expect(addr).toBe('93.184.216.34');
  });
});

describe('fetchCampaignPage', () => {
  it('reads a page and reduces it to text without scripts', async () => {
    const { transport } = scripted({
      'https://cand.example/': {
        body: body(
          '<html><head><title>Jane &amp; Co</title><meta name="description" content="Fighting for you">',
          '<script>steal()</script><style>.x{}</style></head><body><h1>Our Plan</h1><p>Lower costs.</p>',
          '<a href="/issues">Issues</a><a href="https://other.example/issues">Elsewhere</a><a href="/privacy">Privacy Policy</a>',
          '<nav><a href="/">Home</a> MENU-NOISE</nav><!-- hidden --></body></html>',
        ),
      },
    });
    const r = await fetchCampaignPage('https://cand.example/', { transport });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.page.title).toBe('Jane & Co');
    expect(r.page.description).toBe('Fighting for you');
    expect(r.page.headings).toEqual(['Our Plan']);
    expect(r.page.text).toContain('Lower costs.');
    expect(r.page.text).not.toMatch(/steal|hidden|\.x\{|MENU-NOISE/);
    expect(r.page.issue_links).toEqual([{ label: 'Issues', url: 'https://cand.example/issues' }]);
  });

  it('follows a redirect only to another allowed https URL', async () => {
    const ok = scripted({
      'https://cand.example/': { status: 301, location: '/home' },
      'https://cand.example/home': { body: body('<p>hi</p>') },
    });
    expect((await fetchCampaignPage('https://cand.example/', { transport: ok.transport })).ok).toBe(true);
    expect(ok.dialled).toEqual(['https://cand.example/', 'https://cand.example/home']);

    for (const location of ['http://cand.example/', 'https://127.0.0.1/admin', 'https://169.254.169.254/latest/meta-data', 'https://localhost/']) {
      const s = scripted({ 'https://cand.example/': { status: 302, location } });
      const r = await fetchCampaignPage('https://cand.example/', { transport: s.transport });
      expect(r.ok, location).toBe(false);
      expect(!r.ok && r.error).toMatch(/^refused/);
      expect(s.dialled).toHaveLength(1);
    }
  });

  it('stops after the redirect limit', async () => {
    const loop = scripted({
      'https://a.example/': { status: 302, location: 'https://b.example/' },
      'https://b.example/': { status: 302, location: 'https://a.example/' },
    });
    const r = await fetchCampaignPage('https://a.example/', { transport: loop.transport, maxRedirects: 3 });
    expect(r).toMatchObject({ ok: false, error: 'too many redirects' });
    expect(loop.dialled).toHaveLength(4);
  });

  it('caps the body size', async () => {
    const big = scripted({ 'https://cand.example/': { contentType: 'text/plain', body: body('a'.repeat(600), 'b'.repeat(600)) } });
    const r = await fetchCampaignPage('https://cand.example/', { transport: big.transport, maxBytes: 1000 });
    expect(r.ok && r.truncated).toBe(true);
    expect(r.ok && r.bytes).toBe(1000);
    const capped = await readCapped(body('xyz', 'abc'), 4);
    expect(capped).toEqual({ text: 'xyza', truncated: true, bytes: 4 });
  });

  it('refuses non-pages and http before dialling', async () => {
    const pdf = scripted({ 'https://cand.example/': { contentType: 'application/pdf' } });
    expect(await fetchCampaignPage('https://cand.example/', { transport: pdf.transport })).toMatchObject({ ok: false });
    const none = scripted({});
    expect(await fetchCampaignPage('http://cand.example/', { transport: none.transport })).toMatchObject({ ok: false, error: 'refused: https only' });
    expect(none.dialled).toEqual([]);
  });

  it('reports a blocked DNS answer as refused, not as an outage', async () => {
    const transport: Transport = async () => {
      const e = new Error('blocked') as NodeJS.ErrnoException;
      e.code = 'EBLOCKEDADDR';
      throw e;
    };
    expect(await fetchCampaignPage('https://rebind.example/', { transport })).toMatchObject({
      ok: false,
      error: 'refused: resolves to a private or reserved address',
    });
  });

  it('htmlToText caps the excerpt', () => {
    expect(htmlToText(`<body>${'word '.repeat(5000)}</body>`, 'https://x.example/', 100).text.length).toBeLessThanOrEqual(100);
  });
});

describe('www fallback', () => {
  it('retries https://www.<host> once when the bare host has the wrong certificate', async () => {
    const dialled: string[] = [];
    const transport: Transport = async (url) => {
      dialled.push(url.toString());
      if (url.hostname === 'cand.example') {
        const e = new Error('altname') as NodeJS.ErrnoException;
        e.code = 'ERR_TLS_CERT_ALTNAME_INVALID';
        throw e;
      }
      return respond({ body: body('<title>Cand</title>') });
    };
    const r = await fetchCampaignPage('https://cand.example/', { transport });
    expect(dialled).toEqual(['https://cand.example/', 'https://www.cand.example/']);
    expect(r).toMatchObject({ ok: true, url: 'https://cand.example/', final_url: 'https://www.cand.example/' });
  });

  it('does not retry a refusal or a plain HTTP error', async () => {
    const dialled: string[] = [];
    const transport: Transport = async (url) => {
      dialled.push(url.toString());
      return respond({ status: 500 });
    };
    expect((await fetchCampaignPage('https://cand.example/', { transport })).ok).toBe(false);
    expect(dialled).toEqual(['https://cand.example/']);
  });
});
