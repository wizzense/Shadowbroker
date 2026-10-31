/**
 * Candidates for the elections the CIVIC panel lists.
 *
 * Sources (all fetched server-side by `app/api/civic-candidates/[...path]`,
 * keys from env only):
 *   - Federal: OpenFEC `/v1/candidates/totals/` — every candidate registered
 *     with the FEC for a race, with party, incumbent/challenger/open-seat and
 *     money raised/spent. FEC registration is NOT ballot status: primary
 *     candidates who lost still appear, and the panel says so.
 *   - State/local: Google Civic `voterinfo`, which needs a street address and
 *     GOOGLE_CIVIC_API_KEY. Without both, the panel says the list is not
 *     available — it never invents one.
 *
 * This module is pure (no fetch, no node:*), shared by the route, the panel,
 * the WebMCP tools and the tests.
 */

import { CIVIC_STATE_CODES } from '@/lib/civicDirectory';

export type CandidateSource = 'fec' | 'google';

export type CandidateLink = {
  label: string;
  url: string;
  kind: 'campaign' | 'fec' | 'ballotpedia' | 'votesmart' | 'channel';
  /** True for a search/guess URL (Ballotpedia, Vote Smart): a link, not a fact. */
  search?: boolean;
};

export type CandidateMoney = {
  receipts: number | null;
  disbursements: number | null;
  cash_on_hand: number | null;
  coverage_end: string;
};

export type Candidate = {
  /** `fec:<FEC candidate id>` or `gc:<opaque id issued by the server>`. */
  id: string;
  source: CandidateSource;
  name: string;
  party: string;
  /** Incumbent / Challenger / Open seat (FEC), or '' when the source does not say. */
  status: string;
  office: string;
  state: string;
  district: string;
  cycle: number | null;
  money: CandidateMoney | null;
  photo_url: string;
  links: CandidateLink[];
  /** The server knows a campaign URL for this candidate (FEC committee website, Google candidateUrl). */
  has_campaign_site: boolean;
};

export type CandidateList = {
  race: { office: string; state: string; district: string; cycle: number | null };
  candidates: Candidate[];
  source: { name: string; url: string; retrieved_at: string };
  notes: string[];
  rate_limited: boolean;
};

// ─── Names and links ────────────────────────────────────────────────────────

const SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV', 'V']);
const HONORIFICS = new Set(['MR', 'MRS', 'MS', 'DR', 'HON', 'REV']);

function titleCase(word: string): string {
  const w = word.toLowerCase();
  const cap = (s: string) => s.replace(/(^|[-'])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
  if (/^mc[a-z]{2,}/.test(w)) return `Mc${cap(w.slice(2))}`;
  return cap(w);
}

/** FEC "LAST, FIRST MIDDLE JR." → "First Middle Last Jr." */
export function fecDisplayName(raw: string): string {
  const s = (raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const [lastPart, restPart = ''] = s.split(/,\s*/, 2);
  const rest = restPart.split(' ').filter(Boolean);
  const given: string[] = [];
  const suffix: string[] = [];
  for (const tok of rest) {
    const bare = tok.replace(/\./g, '').toUpperCase();
    if (SUFFIXES.has(bare)) suffix.push(bare === 'JR' || bare === 'SR' ? `${titleCase(bare)}.` : bare);
    else if (!HONORIFICS.has(bare)) given.push(titleCase(tok));
  }
  const last = lastPart.split(' ').map(titleCase).join(' ');
  return [...given, last, ...suffix].join(' ').trim();
}

/** A Ballotpedia article URL built from the name. A guess, so it is labelled as a link. */
export function ballotpediaUrl(name: string): string {
  return `https://ballotpedia.org/${encodeURIComponent(name.trim().replace(/\s+/g, '_')).replace(/%2C/g, ',')}`;
}

export function voteSmartSearchUrl(name: string): string {
  return `https://justfacts.votesmart.org/search?search=${encodeURIComponent(name.trim()).replace(/%20/g, '+')}`;
}

export function fecCandidateUrl(fecId: string): string {
  return `https://www.fec.gov/data/candidate/${encodeURIComponent(fecId)}/`;
}

/** Only http(s) URLs survive; FEC writes websites as "EXAMPLE.COM" with no scheme. */
export function normalizeCampaignUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s || s.length > 500 || /\s/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname.includes('.')) return null;
    // Campaign pages are fetched over https only; upgrade the scheme.
    u.protocol = 'https:';
    return u.toString();
  } catch {
    return null;
  }
}

// ─── FEC ────────────────────────────────────────────────────────────────────

export const FEC_SOURCE = { name: 'OpenFEC (Federal Election Commission)', url: 'https://api.open.fec.gov/developers/' };

export type FecOffice = 'H' | 'S' | 'P';

/** CIVIC elections office label → FEC office code. */
export function fecOfficeFor(office: string | undefined | null): FecOffice | null {
  const o = (office || '').toLowerCase();
  if (/house|representative/.test(o)) return 'H';
  if (/senate|senator/.test(o)) return 'S';
  if (/president/.test(o)) return 'P';
  return null;
}

/** FEC two-year cycle that contains a date ("2026-11-03" → 2026, 2027 → 2028). */
export function fecCycleFor(date: string | undefined | null): number | null {
  const y = Number((date || '').slice(0, 4));
  if (!Number.isInteger(y) || y < 1976 || y > 2100) return null;
  return y % 2 === 0 ? y : y + 1;
}

const OFFICE_LABEL: Record<string, string> = { H: 'U.S. House', S: 'U.S. Senate', P: 'President' };
const STATUS_LABEL: Record<string, string> = { I: 'Incumbent', C: 'Challenger', O: 'Open seat' };

function money(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

/**
 * OpenFEC `/candidates/totals/` (or `/candidates/`) results → candidates,
 * richest first. Rows without a candidate id are dropped; duplicates (one row
 * per cycle) collapse to the first.
 */
export function shapeFecCandidates(raw: unknown, cycle: number | null): Candidate[] {
  const results = (raw as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const r of results as Array<Record<string, unknown>>) {
    const fecId = str(r?.candidate_id);
    if (!/^[HSP][0-9A-Z]{8}$/.test(fecId) || seen.has(fecId)) continue;
    seen.add(fecId);
    const name = fecDisplayName(str(r.name));
    const office = str(r.office);
    const district = str(r.district).replace(/^0+(?=\d)/, '');
    const receipts = money(r.receipts);
    const hasMoney = 'receipts' in r || 'disbursements' in r;
    out.push({
      id: `fec:${fecId}`,
      source: 'fec',
      name,
      party: str(r.party_full) || str(r.party),
      status: STATUS_LABEL[str(r.incumbent_challenge)] || str(r.incumbent_challenge_full),
      office: OFFICE_LABEL[office] || str(r.office_full),
      state: str(r.state),
      district: office === 'H' && district !== '0' ? district : '',
      cycle,
      money: hasMoney
        ? {
            receipts,
            disbursements: money(r.disbursements),
            cash_on_hand: money(r.cash_on_hand_end_period),
            coverage_end: str(r.coverage_end_date),
          }
        : null,
      photo_url: '',
      links: [
        { label: 'FEC filings', url: fecCandidateUrl(fecId), kind: 'fec' },
        { label: 'Ballotpedia (search by name)', url: ballotpediaUrl(name), kind: 'ballotpedia', search: true },
        { label: 'Vote Smart (search by name)', url: voteSmartSearchUrl(name), kind: 'votesmart', search: true },
      ],
      has_campaign_site: false,
    });
  }
  return out.sort((a, b) => (b.money?.receipts ?? -1) - (a.money?.receipts ?? -1) || a.name.localeCompare(b.name));
}

/** The principal campaign committee's website from `/candidate/{id}/committees/`. */
export function fecCommitteeWebsite(raw: unknown): string | null {
  const results = (raw as { results?: unknown })?.results;
  if (!Array.isArray(results)) return null;
  const rows = results as Array<Record<string, unknown>>;
  const principal = rows.find((r) => r?.designation === 'P') ?? rows[0];
  for (const r of [principal, ...rows]) {
    const url = normalizeCampaignUrl(r?.website);
    if (url) return url;
  }
  return null;
}

/** Validate the /federal query. The current cycle is the default. */
export function parseFederalQuery(params: URLSearchParams):
  | { ok: true; state: string; office: 'H' | 'S' | 'P'; district: string; cycle: number }
  | { ok: false; message: string } {
  const state = (params.get('state') || '').toUpperCase();
  const office = (params.get('office') || '').toUpperCase();
  if (!CIVIC_STATE_CODES.has(state) && office !== 'P') return { ok: false, message: 'state is a two-letter code.' };
  if (office !== 'H' && office !== 'S' && office !== 'P') return { ok: false, message: 'office is H, S or P.' };
  const rawDistrict = params.get('district') || '';
  if (rawDistrict && !/^\d{1,2}$/.test(rawDistrict)) return { ok: false, message: 'district is 1-2 digits.' };
  const district = office === 'H' && rawDistrict ? rawDistrict.padStart(2, '0') : '';
  const year = new Date().getUTCFullYear();
  const rawCycle = params.get('cycle');
  const cycle = rawCycle ? Number(rawCycle) : year % 2 === 0 ? year : year + 1;
  if (!Number.isInteger(cycle) || cycle % 2 !== 0 || cycle < 1980 || cycle > year + 6) {
    return { ok: false, message: 'cycle is an even election year.' };
  }
  return { ok: true, state, office, district, cycle };
}

// ─── Google Civic voterinfo ─────────────────────────────────────────────────

export const GOOGLE_CIVIC_SOURCE = { name: 'Google Civic Information API (voterinfo)', url: 'https://developers.google.com/civic-information' };

export type BallotContest = {
  office: string;
  district: string;
  level: string;
  candidates: Candidate[];
};

const CHANNEL_URL: Record<string, (id: string) => string> = {
  facebook: (id) => `https://www.facebook.com/${encodeURIComponent(id)}`,
  twitter: (id) => `https://x.com/${encodeURIComponent(id)}`,
  youtube: (id) => `https://www.youtube.com/${encodeURIComponent(id)}`,
};

function channelUrl(type: string, id: string): string | null {
  if (!id) return null;
  if (/^https?:\/\//i.test(id)) return normalizeCampaignUrl(id);
  const make = CHANNEL_URL[type.toLowerCase()];
  return make ? make(id.replace(/^@/, '')) : null;
}

/**
 * voterinfo contests → candidate contests. `issueId` gives each candidate the
 * opaque id the server will accept for a campaign-page fetch; the server keeps
 * the id → URL map, so a client can never make it fetch an arbitrary URL.
 */
export function shapeGoogleVoterInfo(
  raw: unknown,
  issueId: (c: { name: string; office: string; url: string | null }) => string,
): { election: { name: string; day: string }; contests: BallotContest[] } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const el = (r.election ?? {}) as Record<string, unknown>;
  const contests: BallotContest[] = [];
  for (const c of (Array.isArray(r.contests) ? r.contests : []) as Array<Record<string, unknown>>) {
    const cands = Array.isArray(c?.candidates) ? (c.candidates as Array<Record<string, unknown>>) : [];
    if (!cands.length) continue; // referenda carry no candidates
    const office = str(c.office) || str(c.ballotTitle);
    const district = str((c.district as Record<string, unknown> | undefined)?.name);
    const level = Array.isArray(c.level) ? (c.level as unknown[]).map(str).join(', ') : '';
    contests.push({
      office,
      district,
      level,
      candidates: cands.map((x) => {
        const name = str(x.name);
        const site = normalizeCampaignUrl(x.candidateUrl);
        const links: CandidateLink[] = [];
        if (site) links.push({ label: 'Campaign site', url: site, kind: 'campaign' });
        for (const ch of (Array.isArray(x.channels) ? x.channels : []) as Array<Record<string, unknown>>) {
          const u = channelUrl(str(ch?.type), str(ch?.id));
          if (u) links.push({ label: str(ch.type) || 'Channel', url: u, kind: 'channel' });
        }
        links.push({ label: 'Ballotpedia (search by name)', url: ballotpediaUrl(name), kind: 'ballotpedia', search: true });
        links.push({ label: 'Vote Smart (search by name)', url: voteSmartSearchUrl(name), kind: 'votesmart', search: true });
        const photo = normalizeCampaignUrl(x.photoUrl);
        return {
          id: issueId({ name, office, url: site }),
          source: 'google' as const,
          name,
          party: str(x.party),
          status: '',
          office,
          state: '',
          district,
          cycle: fecCycleFor(str(el.electionDay)),
          money: null,
          photo_url: photo ?? '',
          links,
          has_campaign_site: !!site,
        };
      }),
    });
  }
  return { election: { name: str(el.name), day: str(el.electionDay) }, contests };
}

// ─── Client URLs ────────────────────────────────────────────────────────────

const API = '/api/civic-candidates';

export function federalCandidatesUrl(state: string, office: FecOffice, district?: string, cycle?: number | null): string {
  const q = new URLSearchParams({ state, office });
  if (office === 'H' && district && /^\d{1,2}$/.test(district)) q.set('district', district.padStart(2, '0'));
  if (cycle) q.set('cycle', String(cycle));
  return `${API}/federal?${q.toString()}`;
}

export function candidatePageUrl(candidateId: string): string {
  return `${API}/page?id=${encodeURIComponent(candidateId)}`;
}

export const CANDIDATE_ID = /^(fec:[HSP][0-9A-Z]{8}|gc:[a-f0-9]{16})$/;

/** The prompt the "Ask the map" button puts in the agent chat. */
export function candidateAgentPrompt(c: Pick<Candidate, 'id' | 'name' | 'office' | 'state' | 'district'>): string {
  const race = [c.office, c.state, c.district ? `district ${c.district}` : ''].filter(Boolean).join(' ');
  return (
    `Summarize ${c.name}'s platform and policy positions${race ? ` (${race})` : ''} from their campaign site; ` +
    `cite it. Use get_candidate_page with candidate_id "${c.id}" and say plainly if the page states no positions.`
  );
}
