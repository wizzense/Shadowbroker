/**
 * OpenAI-compatible transport shared by the awdk, awnode, hosted and GobboNet
 * adapters: request building, SSE stream parsing (text + tool_call deltas), and
 * a health probe that turns each failure into an actionable sentence.
 */
import { toPromptedMessages } from './promptedTools';
import type { AdapterHealth, AdapterId, ChatRequest, ChatToolCall, ChatTurn, FetchLike, ModelAdapter } from './types';

export interface OpenAICompatOptions {
  id: AdapterId;
  label: string;
  /** Base URL WITHOUT /v1 (e.g. http://127.0.0.1:9001 or /api/agent-llm/hosted). */
  baseUrl: string;
  nativeTools: boolean;
  /** Bearer token/API key source (sessionStorage); '' = send no Authorization. */
  getToken?: () => string;
  /** Extra JSON fields merged into every chat body (e.g. awdk's `plain: true`). */
  extraBody?: Record<string, unknown>;
  /** Unauthenticated liveness path probed before /v1/models (optional). */
  healthPath?: string;
  /** What to tell the operator when the browser cannot reach the daemon at all. */
  blockedHint: string;
  /** What to tell the operator on 401/403. */
  authHint: string;
  credential?: ModelAdapter['credential'];
  fetchImpl?: FetchLike;
  defaultModel?: string;
}

/** Wire-format messages for the request body. */
export function toWireMessages(req: ChatRequest, nativeTools: boolean): unknown[] {
  if (!nativeTools) return toPromptedMessages(req.messages);
  return req.messages.map((m) => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.tool_calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments },
        })),
      };
    }
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
    return { role: m.role, content: m.content };
  });
}

export function buildChatBody(
  req: ChatRequest,
  opts: { nativeTools: boolean; extraBody?: Record<string, unknown>; defaultModel?: string },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messages: toWireMessages(req, opts.nativeTools),
    stream: true,
    temperature: 0.3,
    max_tokens: 1500,
    ...(opts.extraBody ?? {}),
  };
  const model = req.model || opts.defaultModel;
  if (model) body.model = model;
  if (opts.nativeTools && req.tools?.length) {
    body.tools = req.tools;
    body.tool_choice = 'auto';
  }
  return body;
}

export function authHeaders(token: string | undefined): Record<string, string> {
  const t = (token ?? '').trim();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

interface PartialCall {
  id: string;
  name: string;
  arguments: string;
}

/** Accumulate one parsed chunk (stream delta OR full non-stream message) into the turn. */
function absorb(
  json: Record<string, unknown>,
  state: { content: string; calls: Map<number, PartialCall> },
  onText?: (d: string) => void,
): void {
  const choice = (json.choices as Array<Record<string, unknown>> | undefined)?.[0];
  if (!choice) return;
  const part = (choice.delta ?? choice.message) as Record<string, unknown> | undefined;
  if (!part) return;
  if (typeof part.content === 'string' && part.content) {
    state.content += part.content;
    onText?.(part.content);
  }
  const tcs = part.tool_calls as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(tcs)) {
    tcs.forEach((tc, i) => {
      const idx = typeof tc.index === 'number' ? tc.index : i;
      const fn = (tc.function ?? {}) as { name?: string; arguments?: unknown };
      const cur = state.calls.get(idx) ?? { id: '', name: '', arguments: '' };
      if (typeof tc.id === 'string' && tc.id) cur.id = tc.id;
      if (typeof fn.name === 'string' && fn.name) cur.name = fn.name;
      if (typeof fn.arguments === 'string') cur.arguments += fn.arguments;
      else if (fn.arguments && typeof fn.arguments === 'object') cur.arguments = JSON.stringify(fn.arguments);
      state.calls.set(idx, cur);
    });
  }
}

function finish(state: { content: string; calls: Map<number, PartialCall> }): ChatTurn {
  const toolCalls: ChatToolCall[] = [...state.calls.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, c]) => c.name)
    .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, arguments: c.arguments || '{}' }));
  return { content: state.content, toolCalls };
}

/** Read an OpenAI chat response: SSE stream or a single JSON body. */
export async function readChatResponse(res: Response, onText?: (d: string) => void): Promise<ChatTurn> {
  const state = { content: '', calls: new Map<number, PartialCall>() };
  const ctype = res.headers.get('content-type') ?? '';
  if (!ctype.includes('text/event-stream') || !res.body) {
    const json = (await res.json()) as Record<string, unknown>;
    absorb(json, state, onText);
    return finish(state);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const handleLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return false;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') return true;
    try {
      const json = JSON.parse(data) as Record<string, unknown>;
      if (json.error) throw new Error(typeof json.error === 'string' ? json.error : JSON.stringify(json.error));
      absorb(json, state, onText);
    } catch (e) {
      if (e instanceof SyntaxError) return false; // partial/keep-alive line
      throw e;
    }
    return false;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (handleLine(line)) {
        await reader.cancel().catch(() => {});
        return finish(state);
      }
    }
  }
  if (buffer) handleLine(buffer);
  return finish(state);
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const text = (await res.text()).slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: unknown; detail?: unknown };
      const msg = j.error ?? j.detail;
      if (msg) return typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 300);
    } catch {
      /* not JSON */
    }
    return text || res.statusText;
  } catch {
    return res.statusText;
  }
}

export function createOpenAICompatAdapter(opts: OpenAICompatOptions): ModelAdapter {
  const doFetch: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const base = opts.baseUrl.replace(/\/+$/, '');
  const token = () => opts.getToken?.() ?? '';

  return {
    id: opts.id,
    label: opts.label,
    nativeTools: opts.nativeTools,
    credential: opts.credential,

    async probe(signal?: AbortSignal): Promise<AdapterHealth> {
      let health: Record<string, unknown> | null = null;
      try {
        if (opts.healthPath) {
          const h = await doFetch(`${base}${opts.healthPath}`, { method: 'GET', signal, cache: 'no-store' });
          if (!h.ok && h.status !== 401 && h.status !== 403) {
            return { state: 'down', detail: `health answered HTTP ${h.status}` };
          }
          health = (await h.json().catch(() => null)) as Record<string, unknown> | null;
        }
        const r = await doFetch(`${base}/v1/models`, {
          method: 'GET',
          headers: authHeaders(token()),
          signal,
          cache: 'no-store',
        });
        if (r.status === 401 || r.status === 403) {
          const offline = health && health.offline === true ? ' (daemon is offline-narrowed)' : '';
          return { state: 'auth', detail: `${opts.authHint}${offline}` };
        }
        if (!r.ok) return { state: 'down', detail: `/v1/models answered HTTP ${r.status}: ${await errorDetail(r)}` };
        const body = (await r.json().catch(() => ({}))) as { data?: Array<{ id?: unknown }> };
        const models = (body.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean).slice(0, 50);
        return { state: 'ok', detail: `${models.length} model(s)`, models };
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return { state: 'down', detail: 'probe timed out' };
        return { state: 'blocked', detail: opts.blockedHint };
      }
    },

    async chat(req: ChatRequest): Promise<ChatTurn> {
      const body = buildChatBody(req, {
        nativeTools: opts.nativeTools,
        extraBody: opts.extraBody,
        defaultModel: opts.defaultModel,
      });
      const res = await doFetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...authHeaders(token()) },
        body: JSON.stringify(body),
        signal: req.signal,
      });
      if (!res.ok) throw new Error(`${opts.label}: HTTP ${res.status} — ${await errorDetail(res)}`);
      return readChatResponse(res, req.onText);
    },
  };
}
