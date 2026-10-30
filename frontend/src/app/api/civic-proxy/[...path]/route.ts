/**
 * AitherOS Civic Atlas proxy — GET only, three allowlisted layers.
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
 * The layer set is an allowlist, the verb is GET, and nothing from the caller
 * is echoed into the upstream URL beyond the query string we validate.
 */

import { NextRequest, NextResponse } from 'next/server';

const ALLOWED_LAYERS = new Set(['alpr', 'datacenters', 'projects']);
const QUERY_KEYS = new Set(['lat', 'lng', 'radius_km', 'state', 'county', 'cd', 'format', 'leads']);
const CACHE_TTL_MS = 15 * 60 * 1000;
const STALE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 96;
const UPSTREAM_TIMEOUT_MS = 20000;
/** After a 429/503 from the upstream, stop asking for this long. */
const UPSTREAM_COOLDOWN_MS = 60 * 1000;

type CacheEntry = {
  body: string;
  contentType: string;
  storedAt: number;
};

const cache = new Map<string, CacheEntry>();
let upstreamBlockedUntil = 0;

function civicApiBase(): string {
  return (process.env.CIVIC_API_BASE || 'https://app.aitherium.com/api/civic').replace(/\/+$/, '');
}

function remember(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function fresh(entry: CacheEntry | undefined): boolean {
  return !!entry && Date.now() - entry.storedAt < CACHE_TTL_MS;
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
  if (segments.length !== 1 || !ALLOWED_LAYERS.has(segments[0])) {
    return NextResponse.json(
      { error: 'not_found', message: `Unknown civic layer: ${segments.join('/')}` },
      { status: 404 },
    );
  }
  const layer = segments[0];

  const search = new URLSearchParams();
  for (const [key, value] of req.nextUrl.searchParams.entries()) {
    if (QUERY_KEYS.has(key) && value.length <= 32) search.set(key, value);
  }
  if (!search.has('lat') && !search.has('lng') && !search.has('state') && !search.has('county')) {
    return NextResponse.json(
      { error: 'area_required', message: 'Give lat/lng or a state/county.' },
      { status: 422 },
    );
  }

  const upstreamUrl = `${civicApiBase()}/layers/${layer}?${search.toString()}`;
  const cached = cache.get(upstreamUrl);
  if (fresh(cached)) return serveCached(cached as CacheEntry, 'fresh');

  if (Date.now() < upstreamBlockedUntil) {
    if (cached) return serveCached(cached, 'stale');
    return NextResponse.json(
      { error: 'upstream_cooling_down', message: 'Civic API recently refused; retrying shortly.' },
      { status: 503, headers: { 'Retry-After': '60' } },
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
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
        upstreamBlockedUntil = Date.now() + UPSTREAM_COOLDOWN_MS;
      }
      if (cached && Date.now() - cached.storedAt < STALE_TTL_MS) {
        return serveCached(cached, 'stale');
      }
      return new NextResponse(body, {
        status: res.status === 429 ? 429 : 502,
        headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' },
      });
    }
    remember(upstreamUrl, { body, contentType, storedAt: Date.now() });
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
