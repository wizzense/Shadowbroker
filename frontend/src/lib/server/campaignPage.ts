/**
 * Fetch ONE candidate campaign page, safely, and reduce it to text.
 *
 * The URL never comes from the browser: the route resolves a candidate id to
 * the website its source record names (FEC committee `website`, Google Civic
 * `candidateUrl`). Even so, a campaign site is third-party content, so the
 * fetch is fenced:
 *
 *   - https only, port 443, no credentials in the URL, a dotted hostname;
 *   - every DNS answer is checked at CONNECT time (custom `lookup`), so a
 *     hostname that resolves — or re-resolves — to a loopback, private,
 *     link-local, CGNAT, multicast or reserved address is refused (no SSRF,
 *     no DNS-rebinding window between check and connect);
 *   - redirects are followed by hand, at most 3, each target re-checked;
 *   - 10 s timeout, 512 KB body cap, text/html or text/plain only;
 *   - scripts, styles, SVG, iframes and comments are stripped before the text
 *     is excerpted. Nothing from the page is executed or rendered as HTML.
 */
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import type { IncomingMessage } from 'node:http';

export const PAGE_MAX_BYTES = 512 * 1024;
export const PAGE_TIMEOUT_MS = 10_000;
export const PAGE_MAX_REDIRECTS = 3;
export const PAGE_EXCERPT_CHARS = 8000;

// ─── Address and URL policy ─────────────────────────────────────────────────

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function v4Blocked(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

/** Expand an IPv6 literal to 8 hextets (handles `::` and an embedded IPv4 tail). */
function v6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0];
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  if (fill < 0) return null;
  const parts = [...h, ...Array(fill).fill('0'), ...t];
  if (parts.length !== 8) return null;
  const out = parts.map((p) => parseInt(p || '0', 16));
  return out.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? out : null;
}

/** True for any address a campaign-page fetch must never connect to. */
export function isBlockedAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return v4Blocked(ip);
  if (kind !== 6) return true;
  const h = v6Hextets(ip);
  if (!h) return true;
  const embeddedV4 = () => `${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`;
  if (h.slice(0, 7).every((x) => x === 0)) return true; // :: and ::1 (and ::a.b.c.d, deprecated)
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return v4Blocked(embeddedV4()); // ::ffff:a.b.c.d
  if (h[0] === 0x64 && h[1] === 0xff9b) return v4Blocked(embeddedV4()); // NAT64
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((h[0] & 0xff00) === 0xff00) return true; // multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation
  if (h[0] === 0x2002) return v4Blocked(`${h[1] >> 8}.${h[1] & 255}.${h[2] >> 8}.${h[2] & 255}`); // 6to4
  return false;
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** Static checks on a URL before any network I/O. */
export function checkCampaignUrl(raw: string | URL): UrlCheck {
  let u: URL;
  try {
    u = typeof raw === 'string' ? new URL(raw) : raw;
  } catch {
    return { ok: false, reason: 'not a URL' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'https only' };
  if (u.username || u.password) return { ok: false, reason: 'credentials in URL' };
  if (u.port && u.port !== '443') return { ok: false, reason: 'non-standard port' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) return { ok: false, reason: 'private or reserved address' };
    return { ok: true, url: u };
  }
  if (!host.includes('.') || /(^|\.)(localhost|local|internal|lan|home\.arpa)$/i.test(host)) {
    return { ok: false, reason: 'not a public hostname' };
  }
  return { ok: true, url: u };
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;
type Resolver = (host: string, cb: (err: NodeJS.ErrnoException | null, addrs: dns.LookupAddress[]) => void) => void;

const systemResolver: Resolver = (host, cb) => dns.lookup(host, { all: true }, cb);

/**
 * A `lookup` for https.request that refuses blocked answers. Runs at connect
 * time, so the address checked IS the address dialled.
 */
export function guardedLookup(resolve: Resolver = systemResolver) {
  return (hostname: string, options: dns.LookupOptions | number | undefined, callback: LookupCb): void => {
    resolve(hostname, (err, addrs) => {
      if (err) return callback(err, '', 0);
      const list = addrs ?? [];
      const bad = list.find((a) => isBlockedAddress(a.address));
      if (!list.length || bad) {
        const e = new Error(`blocked address for ${hostname}`) as NodeJS.ErrnoException;
        e.code = 'EBLOCKEDADDR';
        return callback(e, '', 0);
      }
      const all = typeof options === 'object' && options?.all;
      if (all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

// ─── Body reading and HTML reduction ────────────────────────────────────────

/** Read at most `maxBytes`; anything past the cap is discarded and flagged. */
export async function readCapped(
  body: AsyncIterable<Uint8Array | string>,
  maxBytes = PAGE_MAX_BYTES,
): Promise<{ text: string; truncated: boolean; bytes: number }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  for await (const chunk of body) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    if (bytes + buf.length > maxBytes) {
      chunks.push(buf.subarray(0, maxBytes - bytes));
      bytes = maxBytes;
      truncated = true;
      break;
    }
    chunks.push(buf);
    bytes += buf.length;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated, bytes };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export type PageText = {
  title: string;
  description: string;
  headings: string[];
  text: string;
  /** Same-site links whose text or path looks like issues / platform / priorities. Not fetched. */
  issue_links: Array<{ label: string; url: string }>;
};

/** HTML → plain text. Script, style, SVG, iframe, noscript and comments are removed first. */
export function htmlToText(html: string, baseUrl: string, maxChars = PAGE_EXCERPT_CHARS): PageText {
  let s = html.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|iframe|template|object|embed)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<(script|style|noscript|svg|iframe|template|object|embed)\b[^>]*\/?>/gi, ' ');
  const clean = (x: string) => decodeEntities(x.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  const title = clean(s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').slice(0, 200);
  const description = clean(
    s.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ??
      s.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i)?.[1] ??
      '',
  ).slice(0, 400);
  const headings = Array.from(s.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi))
    .map((m) => clean(m[1]))
    .filter((h) => h.length > 1 && h.length < 160)
    .slice(0, 30);
  const issue_links: Array<{ label: string; url: string }> = [];
  let base: URL | null = null;
  try {
    base = new URL(baseUrl);
  } catch {
    base = null;
  }
  for (const m of s.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (!base || issue_links.length >= 8) break;
    const label = clean(m[2]).slice(0, 80);
    let u: URL;
    try {
      u = new URL(m[1], base);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' || u.hostname !== base.hostname) continue;
    const hay = `${label} ${u.pathname}`;
    if (!/issue|platform|priorit|polic|agenda|plan|vision|position/i.test(hay)) continue;
    if (/privacy|cookie|terms|donat|contribut|shop|volunteer/i.test(hay)) continue;
    if (issue_links.some((l) => l.url === u.toString())) continue;
    issue_links.push({ label: label || u.pathname, url: u.toString() });
  }
  // Menus repeat on every page and crowd out the content; headings and issue
  // links above were read before this cut.
  const body = (s.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? s).replace(
    /<(nav|header|footer|form|button|select)\b[\s\S]*?<\/\1\s*>/gi,
    ' ',
  );
  const text = decodeEntities(
    body
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article)[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxChars);
  return { title, description, headings, text, issue_links };
}

// ─── The fetch ──────────────────────────────────────────────────────────────

export type RawResponse = {
  status: number;
  location: string | null;
  contentType: string;
  body: AsyncIterable<Uint8Array | string>;
  close: () => void;
};

export type Transport = (url: URL, signal: AbortSignal) => Promise<RawResponse>;

/** Node https with the guarded lookup. No proxy, no keep-alive, no auto-redirect. */
export function httpsTransport(resolve?: Resolver): Transport {
  const lookup = guardedLookup(resolve);
  return (url, signal) =>
    new Promise<RawResponse>((resolveRes, reject) => {
      const req = https.request(
        url,
        {
          method: 'GET',
          lookup: lookup as unknown as typeof dns.lookup,
          agent: false,
          signal,
          headers: {
            'User-Agent': 'ShadowBroker-CivicAtlas/1.0 (+candidate campaign page excerpt)',
            Accept: 'text/html, text/plain;q=0.8',
            'Accept-Encoding': 'identity',
          },
        },
        (res: IncomingMessage) => {
          resolveRes({
            status: res.statusCode ?? 0,
            location: typeof res.headers.location === 'string' ? res.headers.location : null,
            contentType: String(res.headers['content-type'] || ''),
            body: res,
            close: () => res.destroy(),
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
}

export type CampaignPageResult =
  | { ok: true; url: string; final_url: string; status: number; truncated: boolean; bytes: number; page: PageText }
  | { ok: false; url: string; error: string };

type FetchOpts = { transport?: Transport; timeoutMs?: number; maxBytes?: number; maxRedirects?: number };

const TLS_NAME_ERRORS = new Set(['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ECONNREFUSED', 'ENOTFOUND']);

/**
 * Fetch a campaign page. Many campaign sites serve https only on `www.` (the
 * bare domain's certificate names the host platform, e.g. Squarespace, and
 * plain http redirects to https://www.). When the bare host fails that way,
 * try `https://www.<host>` once — still https, still fenced by every check.
 */
export async function fetchCampaignPage(rawUrl: string, opts: FetchOpts = {}): Promise<CampaignPageResult> {
  const first = await fetchCampaignPageOnce(rawUrl, opts);
  if (first.ok || !first.retryWww) return strip(first);
  let www: string;
  try {
    const u = new URL(rawUrl);
    if (u.hostname.startsWith('www.') || net.isIP(u.hostname)) return strip(first);
    u.hostname = `www.${u.hostname}`;
    www = u.toString();
  } catch {
    return strip(first);
  }
  const second = await fetchCampaignPageOnce(www, opts);
  return second.ok ? { ...strip(second), url: rawUrl } : strip(first);
}

function strip(r: CampaignPageResult & { retryWww?: boolean }): CampaignPageResult {
  if (r.ok) return r;
  return { ok: false, url: r.url, error: r.error };
}

async function fetchCampaignPageOnce(
  rawUrl: string,
  opts: FetchOpts,
): Promise<CampaignPageResult & { retryWww?: boolean }> {
  const transport = opts.transport ?? httpsTransport();
  const maxRedirects = opts.maxRedirects ?? PAGE_MAX_REDIRECTS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? PAGE_TIMEOUT_MS);
  let current = checkCampaignUrl(rawUrl);
  try {
    for (let hop = 0; ; hop++) {
      if (!current.ok) return { ok: false, url: rawUrl, error: `refused: ${current.reason}` };
      const res = await transport(current.url, controller.signal);
      if (res.status >= 300 && res.status < 400 && res.location) {
        res.close();
        if (hop >= maxRedirects) return { ok: false, url: rawUrl, error: 'too many redirects' };
        let next: URL;
        try {
          next = new URL(res.location, current.url);
        } catch {
          return { ok: false, url: rawUrl, error: 'bad redirect' };
        }
        current = checkCampaignUrl(next);
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        res.close();
        return { ok: false, url: rawUrl, error: `campaign site answered HTTP ${res.status}` };
      }
      if (!/^text\/(html|plain)\b|^application\/xhtml\+xml\b/i.test(res.contentType)) {
        res.close();
        return { ok: false, url: rawUrl, error: `not a web page (${res.contentType.split(';')[0] || 'no content type'})` };
      }
      const body = await readCapped(res.body, opts.maxBytes ?? PAGE_MAX_BYTES);
      res.close();
      const finalUrl = current.url.toString();
      return {
        ok: true,
        url: rawUrl,
        final_url: finalUrl,
        status: res.status,
        truncated: body.truncated,
        bytes: body.bytes,
        page: /html/i.test(res.contentType)
          ? htmlToText(body.text, finalUrl)
          : { title: '', description: '', headings: [], text: body.text.slice(0, PAGE_EXCERPT_CHARS), issue_links: [] },
      };
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === 'EBLOCKEDADDR') return { ok: false, url: rawUrl, error: 'refused: resolves to a private or reserved address' };
    if (controller.signal.aborted) return { ok: false, url: rawUrl, error: 'campaign site timed out' };
    const tls = typeof e?.code === 'string' && /CERT|TLS/.test(e.code);
    return {
      ok: false,
      url: rawUrl,
      error: tls ? 'campaign site has no valid HTTPS certificate for this name' : 'campaign site unreachable',
      retryWww: TLS_NAME_ERRORS.has(String(e?.code)),
    };
  } finally {
    clearTimeout(timer);
  }
}
