'use client';

/**
 * Candidates inside the CIVIC panel.
 *
 *   <ElectionCandidates>  an election row that expands to its FEC candidates
 *   <StateLocalBallot>    state/local contests (Google Civic, per address) — or
 *                         a plain statement that they are not available
 *   <CandidateCard>       one candidate: party, status, office, money (FEC),
 *                         links, and "Platform & policies" read ONLY from the
 *                         candidate's own campaign site, plus "Ask the map".
 *
 * Every fetch goes to `/api/civic-candidates/*` (this app's server; keys stay
 * there). Nothing here invents a candidate, a position or a number.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, MessageSquare } from 'lucide-react';
import ExternalImage from '@/components/ExternalImage';
import { requestAgentPrompt } from '@/lib/agentChat/prompt';
import {
  candidateAgentPrompt,
  candidatePageUrl,
  fecCycleFor,
  fecOfficeFor,
  federalCandidatesUrl,
  type BallotContest,
  type Candidate,
  type CandidateList,
} from '@/lib/civicCandidates';
import { civicSafeHref, type CivicElection } from '@/lib/civicDirectory';

const usd = (n: number | null | undefined) =>
  typeof n === 'number' ? `$${Math.round(n).toLocaleString('en-US')}` : '—';

async function getJson<T>(url: string): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const body = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
    if (!res.ok) return { ok: false, message: body?.message || `HTTP ${res.status}` };
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, message: 'Network error.' };
  }
}

function A({ href, children }: { href: string; children: React.ReactNode }) {
  const safe = civicSafeHref(href);
  if (!safe) return <>{children}</>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted hover:text-violet-200">
      {children}
    </a>
  );
}

type PageAnswer = {
  ok: boolean;
  error?: string;
  final_url?: string;
  truncated?: boolean;
  retrieved_at?: string;
  note?: string;
  page?: { title: string; description: string; headings: string[]; text: string; issue_links: Array<{ label: string; url: string }> };
};

function Platform({ candidate }: { candidate: Candidate }) {
  const [state, setState] = useState<{ loading: boolean; answer: PageAnswer | null; error: string | null }>({
    loading: false,
    answer: null,
    error: null,
  });
  const load = useCallback(async () => {
    setState({ loading: true, answer: null, error: null });
    const r = await getJson<PageAnswer>(candidatePageUrl(candidate.id));
    setState(r.ok ? { loading: false, answer: r.data, error: null } : { loading: false, answer: null, error: r.message });
  }, [candidate.id]);

  const a = state.answer;
  return (
    <div className="mt-1.5 border-t border-violet-800/40 pt-1">
      <div className="text-[9px] font-mono font-bold tracking-widest text-violet-300">PLATFORM &amp; POLICIES</div>
      <div className="text-[9px] font-mono text-violet-500/80 leading-snug">
        Read only from the candidate&apos;s own campaign site named in the source record. Claims are the campaign&apos;s, not verified.
      </div>
      <div className="flex gap-1.5 mt-1">
        <button
          type="button"
          onClick={load}
          disabled={state.loading}
          className="text-[10px] font-mono px-1.5 py-0.5 border border-violet-700/50 text-violet-200 hover:bg-violet-900/40 disabled:opacity-50"
        >
          {state.loading ? 'Reading campaign site…' : a ? 'Reload campaign site' : 'Read campaign site'}
        </button>
        <button
          type="button"
          onClick={() => requestAgentPrompt(candidateAgentPrompt(candidate))}
          className="text-[10px] font-mono px-1.5 py-0.5 border border-cyan-700/50 text-cyan-200 hover:bg-cyan-900/40 inline-flex items-center gap-1"
          title="Opens Agent Chat with a prefilled question; you press send"
        >
          <MessageSquare size={10} /> Ask the map about this candidate
        </button>
      </div>
      {state.error && <div className="text-[10px] font-mono text-amber-400/90 mt-1">{state.error}</div>}
      {a && !a.ok && <div className="text-[10px] font-mono text-amber-400/90 mt-1">{a.error}</div>}
      {a?.ok && a.page && (
        <div className="mt-1 space-y-1">
          <div className="text-[10px] font-mono text-violet-200">
            <A href={a.final_url || ''}>{a.page.title || a.final_url}</A>
          </div>
          {a.page.description && <div className="text-[10px] font-mono text-violet-300/90">{a.page.description}</div>}
          {a.page.headings.length > 0 && (
            <div className="text-[10px] font-mono text-violet-300/90">Headings: {a.page.headings.slice(0, 12).join(' · ')}</div>
          )}
          {a.page.issue_links.length > 0 && (
            <div className="text-[10px] font-mono text-violet-300/90">
              Issue pages on the site:{' '}
              {a.page.issue_links.map((l, i) => (
                <span key={l.url}>
                  {i ? ' · ' : ''}
                  <A href={l.url}>{l.label}</A>
                </span>
              ))}
            </div>
          )}
          <div className="max-h-40 overflow-y-auto styled-scrollbar whitespace-pre-wrap text-[10px] font-mono text-gray-300 border border-violet-900/40 bg-black/40 p-1">
            {a.page.text || '(the page has no readable text)'}
          </div>
          <div className="text-[9px] font-mono text-violet-500/80">
            {a.note} {a.truncated ? 'Page cut at 512 KB.' : ''} Fetched {a.retrieved_at?.slice(0, 16).replace('T', ' ')} UTC.
          </div>
        </div>
      )}
    </div>
  );
}

export function CandidateCard({ candidate, onClose }: { candidate: Candidate; onClose: () => void }) {
  const c = candidate;
  const photo = civicSafeHref(c.photo_url);
  return (
    <div className="mt-1 border border-violet-500/60 bg-violet-950/40 px-2 py-1.5" data-testid="candidate-card">
      <div className="flex items-start gap-2">
        {photo && (
          <ExternalImage src={photo} alt={c.name} width={40} height={48} className="w-10 h-12 object-cover border border-violet-800/50" />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-mono font-bold text-violet-100">{c.name}</div>
          <div className="text-[10px] font-mono text-violet-300">
            {[c.party, c.status].filter(Boolean).join(' · ') || 'Party not given by the source'}
          </div>
          <div className="text-[10px] font-mono text-violet-400">
            {[c.office, c.state, c.district ? `District ${c.district}` : '', c.cycle ? `${c.cycle} cycle` : ''].filter(Boolean).join(' · ')}
          </div>
        </div>
        <button type="button" onClick={onClose} className="text-violet-500 hover:text-violet-200 text-[11px] font-mono">
          ✕
        </button>
      </div>
      {c.money && (
        <div className="mt-1 text-[10px] font-mono text-violet-200">
          Raised {usd(c.money.receipts)} · spent {usd(c.money.disbursements)} · cash {usd(c.money.cash_on_hand)}
          {c.money.coverage_end ? <span className="text-violet-500/80"> (FEC, through {c.money.coverage_end.slice(0, 10)})</span> : null}
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] font-mono text-violet-300">
        {c.links.map((l) => (
          <A key={l.url} href={l.url}>
            {l.label} <ExternalLink size={9} className="inline" />
          </A>
        ))}
      </div>
      <Platform candidate={c} />
    </div>
  );
}

function CandidateRows({ candidates }: { candidates: Candidate[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="mt-0.5 space-y-0.5">
      {candidates.map((c) => (
        <div key={c.id}>
          <button
            type="button"
            onClick={() => setOpenId((id) => (id === c.id ? null : c.id))}
            className="w-full text-left text-[10px] font-mono text-violet-100 hover:text-white hover:bg-violet-900/30 px-1"
          >
            {c.name}
            <span className="text-violet-400">
              {c.party ? ` · ${c.party}` : ''}
              {c.status ? ` · ${c.status}` : ''}
              {c.money ? ` · ${usd(c.money.receipts)} raised` : ''}
            </span>
          </button>
          {openId === c.id && <CandidateCard candidate={c} onClose={() => setOpenId(null)} />}
        </div>
      ))}
    </div>
  );
}

/** One election row that expands to its federal candidates. */
export function ElectionCandidates({ election, state, district }: { election: CivicElection; state: string; district: string }) {
  const office = fecOfficeFor(election.office);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<CandidateList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const raceDistrict = office === 'H' ? (election.district ? String(election.district) : district) : '';

  useEffect(() => {
    if (!open || data || loading || !office) return;
    setLoading(true);
    void getJson<CandidateList>(federalCandidatesUrl(state, office, raceDistrict, fecCycleFor(election.date))).then((r) => {
      setLoading(false);
      if (r.ok) setData(r.data);
      else setError(r.message);
    });
  }, [open, data, loading, office, state, raceDistrict, election.date]);

  return (
    <div className="mt-0.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left text-[10px] font-mono text-violet-200 hover:text-white flex items-center gap-1"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span>
          {election.date} · {election.office || 'Election'}
          {raceDistrict ? ` (District ${Number(raceDistrict)})` : ''} · {election.type || ''}
        </span>
      </button>
      {open && (
        <div className="pl-3">
          {!office && <div className="text-[10px] font-mono text-violet-500/80">No candidate source for this office yet.</div>}
          {loading && <div className="text-[10px] font-mono text-violet-400/80">Loading candidates…</div>}
          {error && <div className="text-[10px] font-mono text-amber-400/90">{error}</div>}
          {data && data.candidates.length === 0 && (
            <div className="text-[10px] font-mono text-violet-500/80">The FEC lists no candidates for this race yet.</div>
          )}
          {data && data.candidates.length > 0 && <CandidateRows candidates={data.candidates} />}
          {data && (
            <div className="text-[9px] font-mono text-violet-500/80 mt-0.5 leading-snug">
              {data.notes.join(' ')} Source: <A href={data.source.url}>{data.source.name}</A>
              {data.rate_limited ? ' — RATE-LIMITED (DEMO_KEY)' : ''}.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type BallotAnswer = {
  election: { name: string; day: string } | null;
  contests: BallotContest[];
  notes: string[];
  source: { name: string; url: string };
};

/** State and local contests: Google Civic per address when configured, otherwise said plainly. */
export function StateLocalBallot() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [address, setAddress] = useState('');
  const [answer, setAnswer] = useState<BallotAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void getJson<{ google_civic?: { configured?: boolean } }>('/api/civic-candidates/status').then((r) =>
      setConfigured(r.ok ? !!r.data.google_civic?.configured : false),
    );
  }, []);

  if (configured === null) return null;
  if (!configured) {
    return (
      <div className="text-[9px] font-mono text-violet-500/80 mt-1 leading-snug">
        State and local candidate lists are not available yet (no ballot data source is configured on this server).
        Check your state election office via the how-to-vote links below.
      </div>
    );
  }

  const run = async () => {
    setLoading(true);
    setError(null);
    const r = await getJson<BallotAnswer>(`/api/civic-candidates/ballot?address=${encodeURIComponent(address.trim())}`);
    setLoading(false);
    if (r.ok) setAnswer(r.data);
    else setError(r.message);
  };

  return (
    <div className="mt-1">
      <div className="text-[9px] font-mono text-violet-400/90">State &amp; local ballot (Google Civic needs a street address; it is not stored):</div>
      <div className="flex gap-1 mt-0.5">
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          maxLength={200}
          placeholder="Street, city, state"
          className="flex-1 bg-black/60 border border-violet-800/50 px-1 text-[10px] font-mono text-violet-100"
        />
        <button
          type="button"
          disabled={loading || address.trim().length < 5}
          onClick={run}
          className="text-[10px] font-mono px-1.5 border border-violet-700/50 text-violet-200 disabled:opacity-50"
        >
          {loading ? '…' : 'Ballot'}
        </button>
      </div>
      {error && <div className="text-[10px] font-mono text-amber-400/90">{error}</div>}
      {answer && (
        <div className="mt-0.5">
          {answer.election && (
            <div className="text-[10px] font-mono text-violet-300">
              {answer.election.name} · {answer.election.day}
            </div>
          )}
          {answer.contests.map((ct, i) => (
            <div key={`${ct.office}-${i}`} className="mt-0.5">
              <div className="text-[10px] font-mono text-violet-200">
                {ct.office}
                {ct.district ? ` · ${ct.district}` : ''}
              </div>
              <div className="pl-2">
                <CandidateRows candidates={ct.candidates} />
              </div>
            </div>
          ))}
          {answer.notes.map((n) => (
            <div key={n} className="text-[9px] font-mono text-violet-500/80">{n}</div>
          ))}
          <div className="text-[9px] font-mono text-violet-500/80">
            Source: <A href={answer.source.url}>{answer.source.name}</A>
          </div>
        </div>
      )}
    </div>
  );
}
