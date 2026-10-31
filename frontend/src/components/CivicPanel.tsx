'use client';

/**
 * CIVIC panel — "who represents here".
 *
 * A lookup starts from a map click (on a district line, or anywhere when "Who
 * represents here" is on — see `civicLookupFromMapClick`) or from the "map
 * centre" button. One point fans out to three proxied reads:
 *   /lookup     districts, officials, vacancies, how-to-vote for the state
 *   /elections  upcoming elections for the state and congressional district
 *   /units      the county's local governments (Census of Governments 2022)
 * Officials are grouped Federal / State / County / City / School board, and
 * every section names its source and retrieval date as the API returns them.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Landmark, LocateFixed, Minus, Plus, RefreshCw } from 'lucide-react';
import { getLiveDataBounds } from '@/lib/liveDataViewport';
import {
  CIVIC_LOOKUP_EVENT,
  civicElectionsUrl,
  civicLookupUrl,
  civicSafeHref,
  civicUnitsUrl,
  groupCivicLookup,
  groupForBoundaryKind,
  lookupCongressionalDistrict,
  lookupCountyFips,
  type CivicElectionsAnswer,
  type CivicGroup,
  type CivicGroupKey,
  type CivicLookupAnswer,
  type CivicLookupRequest,
  type CivicUnitsAnswer,
} from '@/lib/civicDirectory';

interface Props {
  layerEnabled?: boolean;
}

type Loaded = {
  request: CivicLookupRequest;
  lookup: CivicLookupAnswer;
  elections: CivicElectionsAnswer | null;
  electionsError: string | null;
  units: CivicUnitsAnswer | null;
  unitsError: string | null;
};

/** Ignore a second lookup this soon after the last one (double clicks, drags). */
const LOOKUP_MIN_INTERVAL_MS = 1200;

function errorText(status: number, what: string): string {
  if (status === 429) return `${what}: daily anonymous quota reached upstream — try again later.`;
  if (status === 503) return `${what}: not loaded on the civic host yet, or temporarily unavailable.`;
  if (status === 504) return `${what}: upstream timed out.`;
  return `${what}: unavailable (${status}).`;
}

async function getJson<T>(url: string, what: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(errorText(res.status, what));
  return (await res.json()) as T;
}

function Link({ href, children }: { href: unknown; children: React.ReactNode }) {
  const safe = civicSafeHref(href);
  if (!safe) return <>{children}</>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted hover:text-violet-200">
      {children}
    </a>
  );
}

function Source({ url, label, when }: { url?: string; label?: string; when?: string }) {
  if (!url && !when) return null;
  return (
    <div className="text-[9px] font-mono text-violet-500/80 mt-0.5 break-all">
      {url ? <Link href={url}>{label || 'source'}</Link> : null}
      {when ? ` · ${when.slice(0, 10)}` : ''}
    </div>
  );
}

function GroupBlock({ group, focused }: { group: CivicGroup; focused: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focused]);
  return (
    <div
      ref={ref}
      className={`border px-2 py-1.5 ${focused ? 'border-violet-400/70 bg-violet-900/25' : 'border-violet-800/30 bg-violet-950/15'}`}
    >
      <div className="text-[10px] font-mono font-bold tracking-widest text-violet-300">{group.label.toUpperCase()}</div>
      {group.jurisdictions.length > 0 && (
        <div className="text-[10px] font-mono text-violet-400/90 mt-0.5">
          {group.jurisdictions.map((j) => j.name).join(' · ')}
        </div>
      )}
      {group.officials.map((o, i) => (
        <div key={`${o.id || o.name}-${i}`} className="mt-1">
          <div className="text-[11px] font-mono text-violet-100 leading-tight">
            <Link href={o.url}>{o.name}</Link>
            {o.party ? <span className="text-violet-400"> ({o.party})</span> : null}
          </div>
          <div className="text-[10px] font-mono text-violet-400/90 leading-tight">
            {o.office}
            {o.district ? ` · District ${o.district}` : ''}
            {o.term_end ? ` · term ends ${o.term_end}` : ''}
            {o.phone ? ` · ${o.phone}` : ''}
          </div>
          <Source url={o.source_url} label={o.license ? `source (${o.license})` : 'source'} when={o.retrieved_at} />
        </div>
      ))}
      {group.vacancies.map((v, i) => (
        <div key={`vac-${i}`} className="mt-1 text-[10px] font-mono text-amber-400/90">
          {v.office}
          {v.district ? ` · District ${v.district}` : ''}: {v.note || 'no current holder listed'}
        </div>
      ))}
      {group.units.map((u) => (
        <div key={u.id} className="mt-1">
          <div className="text-[10px] font-mono text-violet-200 leading-tight">
            <Link href={u.website}>{u.name}</Link>
            {u.contact_title ? <span className="text-violet-400"> · {u.contact_title}</span> : null}
          </div>
          {u.office_address && <div className="text-[9px] font-mono text-violet-400/80">{u.office_address}</div>}
          <Source url={u.source_url} label={u.source_vintage || 'Census of Governments'} />
        </div>
      ))}
      {group.officials.length === 0 && group.units.length === 0 && group.vacancies.length === 0 && (
        <div className="text-[10px] font-mono text-violet-500/80 mt-0.5">No officials listed in the source data.</div>
      )}
    </div>
  );
}

export default function CivicPanel({ layerEnabled = false }: Props) {
  const [isMinimized, setIsMinimized] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Loaded | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const lastAtRef = useRef(0);

  const run = useCallback(async (request: CivicLookupRequest, force = false) => {
    const now = Date.now();
    if (!force && now - lastAtRef.current < LOOKUP_MIN_INTERVAL_MS) return;
    lastAtRef.current = now;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const { signal } = controller;
    setIsMinimized(false);
    setLoading(true);
    setError(null);
    try {
      const lookup = await getJson<CivicLookupAnswer>(civicLookupUrl(request.lat, request.lng), 'Lookup', signal);
      if (!lookup.matched || !lookup.state) {
        setData({ request, lookup, elections: null, electionsError: null, units: null, unitsError: null });
        return;
      }
      const district = lookupCongressionalDistrict(lookup);
      const county = lookupCountyFips(lookup);
      const [elections, units] = await Promise.allSettled([
        getJson<CivicElectionsAnswer>(civicElectionsUrl(lookup.state, district), 'Elections', signal),
        county ? getJson<CivicUnitsAnswer>(civicUnitsUrl(lookup.state, county), 'Local governments', signal) : Promise.resolve(null),
      ]);
      if (signal.aborted) return;
      setData({
        request,
        lookup,
        elections: elections.status === 'fulfilled' ? elections.value : null,
        electionsError: elections.status === 'rejected' ? String((elections.reason as Error)?.message || elections.reason) : null,
        units: units.status === 'fulfilled' ? units.value : null,
        unitsError: units.status === 'rejected' ? String((units.reason as Error)?.message || units.reason) : null,
      });
    } catch (err) {
      if (signal.aborted) return;
      setError(err instanceof Error ? err.message : 'Lookup failed.');
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const onLookup = (ev: Event) => {
      const detail = (ev as CustomEvent<CivicLookupRequest>).detail;
      if (detail && Number.isFinite(detail.lat) && Number.isFinite(detail.lng)) void run(detail);
    };
    window.addEventListener(CIVIC_LOOKUP_EVENT, onLookup);
    return () => {
      window.removeEventListener(CIVIC_LOOKUP_EVENT, onLookup);
      controllerRef.current?.abort();
    };
  }, [run]);

  const lookupCenter = useCallback(() => {
    const b = getLiveDataBounds();
    if (!b) {
      setError('The map has not reported a view yet.');
      setIsMinimized(false);
      return;
    }
    let lngSpan = b.east - b.west;
    if (lngSpan < 0) lngSpan += 360;
    void run({ lat: (b.north + b.south) / 2, lng: ((b.west + lngSpan / 2 + 540) % 360) - 180 }, true);
  }, [run]);

  const lookup = data?.lookup;
  const groups = groupCivicLookup(lookup, data?.units?.units ?? []);
  const focusGroup: CivicGroupKey | null = groupForBoundaryKind(data?.request.focusKind);
  const htv = lookup?.how_to_vote;

  return (
    <div className="pointer-events-auto flex-shrink-0 border border-violet-700/40 bg-black/75 backdrop-blur-sm shadow-[0_0_18px_rgba(139,92,246,0.10)]">
      <div
        className="flex items-center justify-between border-b border-violet-700/30 bg-violet-950/20 px-3 py-2.5 cursor-pointer hover:bg-violet-950/40 transition-colors"
        onClick={() => setIsMinimized((prev) => !prev)}
      >
        <div className="flex items-center gap-2">
          <Landmark size={16} className="text-violet-400" />
          <span className="text-[12px] font-mono font-bold tracking-widest text-violet-400">CIVIC</span>
          {lookup?.matched && lookup.state && (
            <span className="text-[11px] font-mono px-1.5 py-0.5 bg-violet-900/30 border border-violet-700/40 text-violet-300 tracking-wider">
              {lookup.state}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              lookupCenter();
            }}
            title="Who represents the map centre"
            className="text-violet-500 transition-colors hover:text-violet-300 p-0.5"
          >
            {loading ? <RefreshCw size={11} className="animate-spin" /> : <LocateFixed size={12} />}
          </button>
          {isMinimized ? <Plus size={16} className="text-violet-400" /> : <Minus size={16} className="text-violet-400" />}
        </div>
      </div>

      {!isMinimized && (
        <div className="px-3 py-2 max-h-[28rem] overflow-y-auto styled-scrollbar space-y-1.5">
          {!data && !error && !loading && (
            <div className="text-[11px] font-mono tracking-wider text-violet-500/80 py-1 leading-snug">
              {layerEnabled
                ? 'Click anywhere in the US on the map, or use the locate button, to see who represents that place.'
                : 'Turn on "Who represents here" (Civic & Elections) to look up by clicking the map, click a district line, or use the locate button for the map centre.'}
            </div>
          )}
          {error && <div className="text-[11px] font-mono text-red-300/90">{error}</div>}
          {loading && !data && <div className="text-[11px] font-mono text-violet-400/80">Looking up…</div>}

          {lookup && !lookup.matched && (
            <div className="text-[11px] font-mono text-violet-400/90">
              {lookup.message || 'No US jurisdiction matched this point.'}{' '}
              <Link href={lookup.how_to_vote_everywhere || 'https://vote.gov/'}>vote.gov</Link>
            </div>
          )}

          {lookup?.matched && (
            <>
              <div className="text-[10px] font-mono text-violet-500/90">
                {lookup.point ? `${lookup.point.lat.toFixed(2)}, ${lookup.point.lng.toFixed(2)} (~1 km)` : ''}
                {data?.request.focusName ? ` · clicked ${data.request.focusName}` : ''}
              </div>
              {groups.map((g) => (
                <GroupBlock key={g.key} group={g} focused={g.key === focusGroup} />
              ))}
              {data?.unitsError && <div className="text-[10px] font-mono text-amber-400/80">{data.unitsError}</div>}

              <div className="border border-violet-800/30 bg-violet-950/15 px-2 py-1.5">
                <div className="text-[10px] font-mono font-bold tracking-widest text-violet-300">UPCOMING ELECTIONS</div>
                {data?.electionsError && <div className="text-[10px] font-mono text-amber-400/80">{data.electionsError}</div>}
                {data?.elections && data.elections.elections.length === 0 && (
                  <div className="text-[10px] font-mono text-violet-500/80">None listed in the source.</div>
                )}
                {data?.elections?.elections.map((e, i) => (
                  <div key={e.id || i} className="text-[10px] font-mono text-violet-200 mt-0.5">
                    {e.date} · {e.office || 'Election'}
                    {e.district ? ` (District ${e.district})` : ''} · {e.type || ''}
                  </div>
                ))}
                {data?.elections?.coverage_note && (
                  <div className="text-[9px] font-mono text-violet-500/80 mt-0.5">{data.elections.coverage_note}</div>
                )}
                {data?.elections?.sources?.map((s) => (
                  <Source key={s} url={s} label={s.replace(/^https?:\/\//, '').split('/')[0]} when={data.elections?.retrieved_at} />
                ))}
              </div>

              {htv && (
                <div className="border border-violet-800/30 bg-violet-950/15 px-2 py-1.5">
                  <div className="text-[10px] font-mono font-bold tracking-widest text-violet-300">
                    HOW TO VOTE — {htv.state}
                  </div>
                  {htv.actions.map((a) => (
                    <div key={a.action} className="text-[10px] font-mono text-violet-200 mt-0.5">
                      <Link href={a.url}>
                        {a.label} <ExternalLink size={9} className="inline" />
                      </Link>
                      {a.note ? <span className="text-violet-500/80"> — {a.note}</span> : null}
                    </div>
                  ))}
                  {htv.notice && <div className="text-[9px] font-mono text-violet-500/80 mt-0.5">{htv.notice}</div>}
                  <Source url={htv.source_url} label={htv.publisher || 'NASS directory'} when={htv.retrieved_at} />
                </div>
              )}

              <div className="text-[9px] font-mono text-violet-500/80 leading-snug">
                Districts: US Census geocoder. Officials: CC0 datasets
                {lookup.officials_retrieved_at ? `, pulled ${lookup.officials_retrieved_at.slice(0, 10)}` : ''}
                {lookup.officials_stale ? ' (STALE)' : ''}. {lookup.coverage_note || ''}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
