/**
 * Candidates for the CIVIC panel — served by ShadowBroker itself (owner rule:
 * nothing new lives in Genesis). GET only; keys come from runtime env and
 * never reach the browser.
 *
 *   /api/civic-candidates/status
 *       which sources are configured (booleans, never key material)
 *   /api/civic-candidates/federal?state=OH&office=H|S|P[&district=01][&cycle=2026]
 *       OpenFEC /v1/candidates/totals/ — FEC_API_KEY, else DEMO_KEY (rate-limited)
 *   /api/civic-candidates/ballot?address=<one line>
 *       Google Civic voterinfo — only with GOOGLE_CIVIC_API_KEY; the address is
 *       not logged, not echoed, and the cache key is its SHA-256
 *   /api/civic-candidates/page?id=fec:H6OH01195 | gc:<16 hex>
 *       an excerpt of THAT candidate's campaign site, the URL resolved here from
 *       the source record (never taken from the caller), fetched through
 *       lib/server/campaignPage.ts (https, public addresses only, capped)
 *
 * OpenStates (OPENSTATES_API_KEY) was checked: its v3 API serves current
 * legislators, not candidates, and those already arrive through /civic/lookup.
 * It is not called here.
 */
import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  CANDIDATE_ID,
  FEC_SOURCE,
  fecCommitteeWebsite,
  parseFederalQuery,
  GOOGLE_CIVIC_SOURCE,
  shapeFecCandidates,
  shapeGoogleVoterInfo,
  type CandidateList,
} from '@/lib/civicCandidates';
import { fetchCampaignPage, type CampaignPageResult } from '@/lib/server/campaignPage';

export const dynamic = 'force-dynamic';

const FEC_BASE = 'https://api.open.fec.gov/v1';
const GOOGLE_BASE = 'https://www.googleapis.com/civicinfo/v2';
const FEC_TTL_MS = 6 * 60 * 60 * 1000;
const WEBSITE_TTL_MS = 24 * 60 * 60 * 1000;
const PAGE_TTL_MS = 12 * 60 * 60 * 1000;
const BALLOT_TTL_MS = 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 20_000;
const COOLDOWN_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 400;

type Entry<T> = { value: T; at: number };

class TtlCache<T> {
  private map = new Map<string, Entry<T>>();
  constructor(private ttl: number, private max = MAX_ENTRIES) {}
  get(key: string, allowStale = false): T | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (!allowStale && Date.now() - e.at > this.ttl) return undefined;
    return e.value;
  }
  set(key: string, value: T): void {
    this.map.delete(key);
    this.map.set(key, { value, at: Date.now() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
}

const fecCache = new TtlCache<CandidateList>(FEC_TTL_MS);
const websiteCache = new TtlCache<string | null>(WEBSITE_TTL_MS);
const pageCache = new TtlCache<CampaignPageResult>(PAGE_TTL_MS, 200);
const ballotCache = new TtlCache<unknown>(BALLOT_TTL_MS, 100);
/** gc:<id> → campaign URL, filled only from Google Civic answers. */
const googleCandidateUrls = new TtlCache<string | null>(7 * 24 * 60 * 60 * 1000, 4000);
let fecBlockedUntil = 0;

function fecKey(): { key: string; demo: boolean } {
  const k = (process.env.FEC_API_KEY || '').trim();
  return k ? { key: k, demo: false } : { key: 'DEMO_KEY', demo: true };
}

function googleKey(): string | null {
  return (process.env.GOOGLE_CIVIC_API_KEY || '').trim() || null;
}

function json(status: number, body: unknown, cache = 'no-store'): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': cache } });
}

function fail(status: number, error: string, message: string): NextResponse {
  return json(status, { error, message });
}

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store', headers: { Accept: 'application/json' } });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

const DEMO_NOTE =
  'FEC data is fetched with the public DEMO_KEY (a few requests an hour); answers are cached for 6 h. Set FEC_API_KEY for a full quota.';
const FEC_SCOPE_NOTE =
  'The FEC lists everyone who registered for this race, including primary candidates who may not be on the general-election ballot.';

// ─── federal ────────────────────────────────────────────────────────────────

async function federal(params: URLSearchParams): Promise<NextResponse> {
  const q = parseFederalQuery(params);
  if (!q.ok) return fail(422, 'bad_query', q.message);
  const cacheKey = `${q.state}|${q.office}|${q.district}|${q.cycle}`;
  const hit = fecCache.get(cacheKey);
  if (hit) return json(200, hit, 'public, max-age=300');
  const stale = fecCache.get(cacheKey, true);
  if (Date.now() < fecBlockedUntil) {
    if (stale) return json(200, { ...stale, notes: [...stale.notes, 'Served from cache: FEC is rate-limiting this server.'] });
    return fail(429, 'fec_rate_limited', 'The FEC API is rate-limiting this server; try again in a few minutes.');
  }
  const { key, demo } = fecKey();
  const u = new URLSearchParams({
    api_key: key,
    cycle: String(q.cycle),
    election_year: String(q.cycle),
    office: q.office,
    per_page: '100',
    sort: '-receipts',
  });
  if (q.office !== 'P') u.set('state', q.state);
  if (q.district) u.set('district', q.district);
  let res: { status: number; body: unknown };
  try {
    res = await getJson(`${FEC_BASE}/candidates/totals/?${u.toString()}`);
  } catch {
    if (stale) return json(200, stale);
    return fail(502, 'fec_unreachable', 'The FEC API did not answer.');
  }
  if (res.status === 429) {
    fecBlockedUntil = Date.now() + COOLDOWN_MS;
    if (stale) return json(200, stale);
    return fail(429, 'fec_rate_limited', demo ? DEMO_NOTE : 'The FEC API is rate-limiting this server.');
  }
  if (res.status !== 200) {
    if (stale) return json(200, stale);
    return fail(502, 'fec_error', `The FEC API answered HTTP ${res.status}.`);
  }
  const list: CandidateList = {
    race: { office: q.office, state: q.office === 'P' ? '' : q.state, district: q.district.replace(/^0/, ''), cycle: q.cycle },
    candidates: shapeFecCandidates(res.body, q.cycle),
    source: { ...FEC_SOURCE, retrieved_at: new Date().toISOString() },
    notes: [FEC_SCOPE_NOTE, ...(demo ? [DEMO_NOTE] : [])],
    rate_limited: demo,
  };
  fecCache.set(cacheKey, list);
  return json(200, list, 'public, max-age=300');
}

async function fecWebsite(fecId: string): Promise<string | null | 'rate_limited'> {
  const cached = websiteCache.get(fecId);
  if (cached !== undefined) return cached;
  if (Date.now() < fecBlockedUntil) return 'rate_limited';
  const { key } = fecKey();
  const res = await getJson(
    `${FEC_BASE}/candidate/${encodeURIComponent(fecId)}/committees/?${new URLSearchParams({ api_key: key, designation: 'P', per_page: '5' })}`,
  );
  if (res.status === 429) {
    fecBlockedUntil = Date.now() + COOLDOWN_MS;
    return 'rate_limited';
  }
  if (res.status !== 200) return null;
  const site = fecCommitteeWebsite(res.body);
  websiteCache.set(fecId, site);
  return site;
}

// ─── ballot (Google Civic) ──────────────────────────────────────────────────

function googleCandidateId(c: { name: string; office: string; url: string | null }): string {
  const id = `gc:${createHash('sha256').update(`${c.name}\u0000${c.office}\u0000${c.url ?? ''}`).digest('hex').slice(0, 16)}`;
  googleCandidateUrls.set(id, c.url);
  return id;
}

async function ballot(params: URLSearchParams): Promise<NextResponse> {
  const key = googleKey();
  if (!key) {
    return fail(501, 'not_configured',
      'State and local candidate lists are not available yet: this server has no GOOGLE_CIVIC_API_KEY.');
  }
  const address = (params.get('address') || '').trim();
  if (address.length < 5 || address.length > 200) return fail(422, 'address_required', 'Give a street address (5-200 characters).');
  const cacheKey = createHash('sha256').update(address.toLowerCase()).digest('hex');
  let body = ballotCache.get(cacheKey);
  if (body === undefined) {
    let res: { status: number; body: unknown };
    try {
      res = await getJson(`${GOOGLE_BASE}/voterinfo?${new URLSearchParams({ key, address, officialOnly: 'false' })}`);
    } catch {
      return fail(502, 'google_unreachable', 'Google Civic did not answer.');
    }
    if (res.status === 400 || res.status === 404) {
      return json(200, {
        election: null,
        contests: [],
        source: { ...GOOGLE_CIVIC_SOURCE, retrieved_at: new Date().toISOString() },
        notes: ['Google Civic has no upcoming election data for this address.'],
      });
    }
    if (res.status !== 200) return fail(502, 'google_error', `Google Civic answered HTTP ${res.status}.`);
    body = res.body;
    ballotCache.set(cacheKey, body);
  }
  const shaped = shapeGoogleVoterInfo(body, googleCandidateId);
  return json(200, {
    ...shaped,
    source: { ...GOOGLE_CIVIC_SOURCE, retrieved_at: new Date().toISOString() },
    notes: shaped.contests.length ? [] : ['Google Civic lists no candidate contests for this address yet.'],
  });
}

// ─── page ───────────────────────────────────────────────────────────────────

async function page(params: URLSearchParams): Promise<NextResponse> {
  const id = params.get('id') || '';
  if (!CANDIDATE_ID.test(id)) return fail(422, 'bad_id', 'id is fec:<FEC candidate id> or gc:<id> from a ballot answer.');
  let site: string | null | 'rate_limited';
  if (id.startsWith('fec:')) {
    try {
      site = await fecWebsite(id.slice(4));
    } catch {
      return fail(502, 'fec_unreachable', 'The FEC API did not answer.');
    }
  } else {
    const known = googleCandidateUrls.get(id);
    if (known === undefined) return fail(404, 'unknown_candidate', 'Load the ballot for this address again, then retry.');
    site = known;
  }
  if (site === 'rate_limited') return fail(429, 'fec_rate_limited', 'The FEC API is rate-limiting this server; try again later.');
  if (!site) {
    return json(200, {
      ok: false,
      candidate_id: id,
      error: 'The source record lists no campaign website for this candidate.',
    });
  }
  let result = pageCache.get(site);
  if (!result) {
    result = await fetchCampaignPage(site);
    // Cache failures briefly too, so a dead site is not hammered by every viewer.
    pageCache.set(site, result);
  }
  return json(200, {
    candidate_id: id,
    retrieved_at: new Date().toISOString(),
    note: 'Text excerpt of the candidate’s own campaign site. Positions are the campaign’s claims, not verified facts.',
    ...result,
  });
}

function status(): NextResponse {
  const { demo } = fecKey();
  return json(200, {
    fec: { configured: !demo, demo_key: demo },
    google_civic: { configured: !!googleKey() },
    openstates: {
      configured: !!(process.env.OPENSTATES_API_KEY || '').trim(),
      used: false,
      note: 'OpenStates v3 serves current legislators, not candidates; incumbents already come from /civic/lookup.',
    },
    state_local_candidates: googleKey()
      ? 'Available per street address (Google Civic voterinfo).'
      : 'Not available yet: no GOOGLE_CIVIC_API_KEY on this server.',
  });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const segs = (await params).path ?? [];
  if (segs.length !== 1) return fail(404, 'not_found', 'Unknown candidates route.');
  const sp = req.nextUrl.searchParams;
  switch (segs[0]) {
    case 'status':
      return status();
    case 'federal':
      return federal(sp);
    case 'ballot':
      return ballot(sp);
    case 'page':
      return page(sp);
    default:
      return fail(404, 'not_found', 'Unknown candidates route.');
  }
}
