/**
 * Hosted-model proxy for the agent chat — two routes, one upstream.
 *
 *   GET  /api/agent-llm/hosted/v1/models
 *   POST /api/agent-llm/hosted/v1/chat/completions
 *
 * Why server-side: the Aitherium OpenAI-compatible plane (mcp.aitherium.com/v1,
 * Bearer aither_sk_… keys) sends no CORS header for this origin. The key is the
 * OPERATOR's own, typed into the chat settings (sessionStorage) and forwarded
 * per request; nothing is embedded in the bundle, stored, or logged here.
 *
 * HOSTED_LLM_BASE (runtime env, never NEXT_PUBLIC_) re-points the upstream.
 * Paths and verbs are an allowlist; the caller controls nothing in the URL.
 */
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const DEFAULT_BASE = 'https://mcp.aitherium.com/v1';
const MAX_BODY_BYTES = 512 * 1024;
const MODELS_TIMEOUT_MS = 15_000;
const CHAT_TIMEOUT_MS = 180_000;

const ROUTES: Record<string, { method: 'GET' | 'POST'; upstream: string }> = {
  'hosted/v1/models': { method: 'GET', upstream: '/models' },
  'hosted/v1/chat/completions': { method: 'POST', upstream: '/chat/completions' },
};

function upstreamBase(): string {
  const raw = (process.env.HOSTED_LLM_BASE || DEFAULT_BASE).trim().replace(/\/+$/, '');
  return /^https:\/\//i.test(raw) ? raw : DEFAULT_BASE;
}

function bearer(req: NextRequest): string | null {
  const h = req.headers.get('authorization') || '';
  if (!/^Bearer [\x21-\x7e]{8,512}$/.test(h)) return null;
  return h;
}

function json(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function handle(req: NextRequest, segments: string[], method: 'GET' | 'POST'): Promise<Response> {
  const route = ROUTES[segments.join('/')];
  if (!route) return json(404, 'unknown agent-llm route');
  if (route.method !== method) return json(405, 'method not allowed');
  const auth = bearer(req);
  if (!auth) return json(401, 'Aitherium API key required (Authorization: Bearer aither_sk_…)');

  let body: string | undefined;
  if (method === 'POST') {
    const ctype = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (ctype !== 'application/json') return json(415, 'application/json required');
    body = await req.text();
    if (body.length > MAX_BODY_BYTES) return json(413, 'request too large');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), method === 'GET' ? MODELS_TIMEOUT_MS : CHAT_TIMEOUT_MS);
  req.signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const upstream = await fetch(`${upstreamBase()}${route.upstream}`, {
      method,
      headers: {
        Authorization: auth,
        Accept: method === 'POST' ? 'text/event-stream, application/json' : 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
      signal: controller.signal,
      cache: 'no-store',
    });
    const headers = new Headers({ 'Cache-Control': 'no-store' });
    const ctype = upstream.headers.get('content-type');
    if (ctype) headers.set('Content-Type', ctype);
    // Stream through; the timer is cleared once the body is fully relayed.
    const relay = upstream.body
      ? upstream.body.pipeThrough(
          new TransformStream({
            flush() {
              clearTimeout(timer);
            },
          }),
        )
      : null;
    if (!relay) clearTimeout(timer);
    return new Response(relay, { status: upstream.status, headers });
  } catch (e) {
    clearTimeout(timer);
    const aborted = (e as Error)?.name === 'AbortError';
    return json(aborted ? 504 : 502, aborted ? 'hosted model timed out' : 'hosted model unreachable');
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return handle(req, (await params).path ?? [], 'GET');
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return handle(req, (await params).path ?? [], 'POST');
}
