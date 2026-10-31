/**
 * AitherOS Civic Atlas proxy — GET only, allowlisted routes.
 *
 * Routes (validation lives in `lib/civicDirectory.ts::resolveCivicProxyRequest`):
 *   /api/civic-proxy/{alpr|datacenters|projects}   point layers (/civic/layers/*)
 *   /api/civic-proxy/lookup?lat=&lng=              districts + officials (no addresses)
 *   /api/civic-proxy/how-to-vote/{STATE}
 *   /api/civic-proxy/geojson/{layer}?state=XX       district boundaries
 *   /api/civic-proxy/units?state=&county=&kind=     local-government directory
 *   /api/civic-proxy/elections?state=&district=     upcoming elections
 *
 * Why this exists instead of the browser calling aitherium.com:
 *  1. CORS. The civic layers are served by AitherOS (Veil -> Genesis) and send
 *     no Access-Control-Allow-Origin for this origin; a server-side hop has no
 *     preflight and no exposure.
 *  2. Quota. Genesis charges an anonymous per-IP quota (600 layer requests a
 *     day). A browser fan-out would key that bucket on every viewer's address
 *     and re-ask the same county for every viewer; here ONE cached lookup per
 *     area serves the whole board.
 *
 * CIVIC_API_BASE is a runtime env var (never NEXT_PUBLIC_), so the upstream can
 * be re-pointed without a rebuild:
 *   CIVIC_API_BASE=https://app.aitherium.com/api/civic   (default)
 *
 * The route set is an allowlist, the verb is GET, and the upstream URL is built
 * only from constants and validated tokens — unknown query keys are dropped.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveCivicProxyRequest, type CivicRouteKind } from '@/lib/civicDirectory';

/** Serve a cached copy this long after a failed refresh. */
const MIN_STALE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 160;
/** A state boundary layer is up to ~1 MB; cap the whole cache, not just its entry count. */
const MAX_CACHE_BYTES = 48 * 1024 * 1024;
/** After a 429/503 from the upstream, stop asking that route kind for this long. */
const UPSTREAM_COOLDOWN_MS = 60 * 1000;

type CacheEntry = {
  body: string;
  contentType: string;
  storedAt: number;
  ttlMs: number;
};

const cache = new Map<string, CacheEntry>();
let cacheBytes = 0;
/** Per route kind: one route's 503 ("directory not loaded") must not silence the others. */
const upstreamBlockedUntil = new Map<CivicRouteKind, number>();

function civicApiBase(): string {
  return (process.env.CIVIC_API_BASE || 'https://app.aitherium.com/api/civic').replace(/\/+$/, '');
}

function forget(key: string): void {
  const old = cache.get(key);
  if (old) cacheBytes -= old.body.length;
  cache.delete(key);
}

function remember(key: string, entry: CacheEntry): void {
  forget(key);
  cache.set(key, entry);
  cacheBytes += entry.body.length;
  while (cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next();
    if (oldest.done || oldest.value === key) break;
    forget(oldest.value);
  }
}

function fresh(entry: CacheEntry | undefined): boolean {
  return !!entry && Date.now() - entry.storedAt < entry.ttlMs;
}

function usableStale(entry: CacheEntry | undefined): entry is CacheEntry {
  return !!entry && Date.now() - entry.storedAt < Math.max(MIN_STALE_TTL_MS, entry.ttlMs * 2);
}

function serveCached(entry: CacheEntry, age: 'fresh' | 'stale'): NextResponse {
  return new NextResponse(entry.body, {
    status: 200,
    headers: {
      'Content-Type': entry.contentType,
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
      'X-Civic-Cache': age,
    },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const segments = (await params).path ?? [];
  const resolved = resolveCivicProxyRequest(segments, req.nextUrl.searchParams);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error, message: resolved.message }, { status: resolved.status });
  }
  const route = resolved.route;

  const upstreamUrl = `${civicApiBase()}${route.upstreamPath}${route.query ? `?${route.query}` : ''}`;
  const cached = cache.get(upstreamUrl);
  if (fresh(cached)) return serveCached(cached as CacheEntry, 'fresh');

  if (Date.now() < (upstreamBlockedUntil.get(route.kind) ?? 0)) {
    if (cached) return serveCached(cached, 'stale');
    return NextResponse.json(
      { error: 'upstream_cooling_down', message: 'Civic API recently refused; retrying shortly.' },
      { status: 503, headers: { 'Retry-After': '60' } },
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), route.timeoutMs);
  try {
    const res = await fetch(upstreamUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'AitherShadowBroker/1.0' },
      signal: controller.signal,
      cache: 'no-store',
    });
    const body = await res.text();
    const contentType = res.headers.get('content-type') || 'application/json';
    if (!res.ok) {
      if (res.status === 429 || res.status === 503) {
        upstreamBlockedUntil.set(route.kind, Date.now() + UPSTREAM_COOLDOWN_MS);
      }
      if (usableStale(cached)) {
        return serveCached(cached, 'stale');
      }
      // 404/422/429/503 carry meaning the panel shows ("not loaded on this host
      // yet", "unknown state"); any other failure is the upstream's, so 502.
      const passThrough = [404, 422, 429, 503].includes(res.status);
      return new NextResponse(body, {
        status: passThrough ? res.status : 502,
        headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' },
      });
    }
    remember(upstreamUrl, { body, contentType, storedAt: Date.now(), ttlMs: route.ttlMs });
    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
        'X-Civic-Cache': 'miss',
      },
    });
  } catch {
    if (cached) return serveCached(cached, 'stale');
    return NextResponse.json(
      { error: 'upstream_unreachable', message: 'Civic API unreachable.' },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
