/**
 * Chat backends: request building, SSE parsing, health probes (mocked fetch),
 * the hosted proxy's allowlist, the Bonsai engine protocol, and the CSP widening.
 */
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { awdkAdapter, awnodeAdapter, createAdapters, gobbonetAdapter, hostedAdapter } from '@/lib/agentChat/adapters';
import { buildChatBody, readChatResponse } from '@/lib/agentChat/openaiCompat';
import { BonsaiEngine, BONSAI_ENGINE_URL, sha256Hex, type WorkerHandle } from '@/lib/agentChat/bonsaiEngine';
import { parseToolCalls } from '@/lib/agentChat/promptedTools';
import { splitThinking } from '@/lib/agentChat/display';
import type { FetchLike } from '@/lib/agentChat/types';
import { proxy } from '@/proxy';

function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const tools = [{ type: 'function' as const, function: { name: 'list_layers', description: 'd', parameters: { type: 'object' as const, properties: {} } } }];

describe('request building', () => {
  it('native adapters send OpenAI tools and tool messages', () => {
    const body = buildChatBody(
      {
        model: 'm',
        tools,
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'list_layers', arguments: '{}' }] },
          { role: 'tool', tool_call_id: 'c1', name: 'list_layers', content: '{"layers":[]}' },
        ],
      },
      { nativeTools: true },
    );
    expect(body).toMatchObject({ model: 'm', stream: true, tool_choice: 'auto', tools });
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs[1]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_layers' } }] });
    expect(msgs[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"layers":[]}' });
  });

  it('prompted adapters send no tools and re-encode tool turns as text', () => {
    const body = buildChatBody(
      {
        tools,
        messages: [
          { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'list_layers', arguments: '{}' }] },
          { role: 'tool', tool_call_id: 'c1', name: 'list_layers', content: 'R' },
        ],
      },
      { nativeTools: false, extraBody: { plain: true } },
    );
    expect(body).not.toHaveProperty('tools');
    expect(body.plain).toBe(true);
    const msgs = body.messages as Array<{ role: string; content: string }>;
    expect(msgs[0].content).toContain('<tool_call>{"name": "list_layers"');
    expect(msgs[1]).toEqual({ role: 'user', content: 'TOOL_RESULT list_layers: R' });
  });

  it('awdk posts plain:true with the session bearer to :9001', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => sse([{ choices: [{ delta: { content: 'hi' } }] }]));
    const a = awdkAdapter({ fetchImpl, getToken: () => 'tok123' });
    const turn = await a.chat({ messages: [{ role: 'user', content: 'q' }], tools });
    expect(turn.content).toBe('hi');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9001/v1/chat/completions');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok123');
    const body = JSON.parse(init!.body as string);
    expect(body.plain).toBe(true);
    expect(body).not.toHaveProperty('tools');
  });

  it('hosted goes through the same-origin proxy, never directly upstream', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => sse([{ choices: [{ delta: { content: 'x' } }] }]));
    await hostedAdapter({ fetchImpl, getToken: () => 'aither_sk_test' }).chat({ messages: [{ role: 'user', content: 'q' }], tools });
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/agent-llm/hosted/v1/chat/completions');
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string).model).toBe('aither-orchestrator');
  });
});

describe('response parsing', () => {
  it('assembles streamed tool_call deltas', async () => {
    const res = sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'search_entities', arguments: '{"que' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"RCH"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'get_summary', arguments: '{}' } }] } }] },
    ]);
    const turn = await readChatResponse(res);
    expect(turn.toolCalls).toEqual([
      { id: 'a', name: 'search_entities', arguments: '{"query":"RCH"}' },
      { id: 'b', name: 'get_summary', arguments: '{}' },
    ]);
  });

  it('reads a non-stream JSON body and streams text deltas', async () => {
    const onText = vi.fn();
    const turn = await readChatResponse(jsonRes(200, { choices: [{ message: { content: 'done' } }] }), onText);
    expect(turn.content).toBe('done');
    expect(onText).toHaveBeenCalledWith('done');
  });

  it('parses prompted tool calls and strips them from display', () => {
    const { calls, text } = parseToolCalls('Checking.\n<tool_call>{"name":"fly_to","arguments":{"lat":1,"lng":2}}</tool_call>');
    expect(calls).toEqual([{ id: 'call_p0', name: 'fly_to', arguments: '{"lat":1,"lng":2}' }]);
    expect(text).toBe('Checking.');
    expect(parseToolCalls('```json\n{"name":"get_summary","arguments":{}}\n```').calls[0].name).toBe('get_summary');
    expect(parseToolCalls('<tool_call>not json</tool_call>').calls).toEqual([]);
  });

  it('display keeps HTML inert text and splits thinking', () => {
    const d = splitThinking('<think>plan</think><img src=x onerror=alert(1)>\u202Eok');
    expect(d.thinking).toBe('plan');
    expect(d.answer).toBe('<img src=x onerror=alert(1)>ok'); // rendered as a text node, never HTML
  });
});

describe('health probes', () => {
  it('ok with models', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) =>
      url.endsWith('/health') ? jsonRes(200, { status: 'healthy' }) : jsonRes(200, { data: [{ id: 'bonsai-8b' }] }),
    );
    expect(await awdkAdapter({ fetchImpl, getToken: () => '' }).probe()).toMatchObject({ state: 'ok', models: ['bonsai-8b'] });
  });

  it('401 reads as auth, with the offline hint', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) =>
      url.endsWith('/health') ? jsonRes(200, { offline: true }) : jsonRes(401, { error: 'local credential required' }),
    );
    const h = await awdkAdapter({ fetchImpl, getToken: () => '' }).probe();
    expect(h.state).toBe('auth');
    expect(h.detail).toMatch(/AITHER_SERVER_API_KEY/);
    expect(h.detail).toMatch(/offline/);
  });

  it('a network/CORS failure reads as blocked with the origin fix', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new TypeError('Failed to fetch');
    });
    const h = await awnodeAdapter({ fetchImpl, getToken: () => '' }).probe();
    expect(h.state).toBe('blocked');
    expect(h.detail).toMatch(/AITHERNODE_ALLOWED_ORIGINS/);
    expect((await gobbonetAdapter({ fetchImpl }).probe()).state).toBe('blocked');
  });

  it('5xx reads as down', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonRes(503, { detail: 'no backend' }));
    expect((await hostedAdapter({ fetchImpl, getToken: () => 'k' }).probe()).state).toBe('down');
  });

  it('every adapter in the registry has a probe and chat', () => {
    const all = createAdapters({ fetchImpl: vi.fn<FetchLike>(), getToken: () => '' });
    for (const a of Object.values(all)) {
      expect(typeof a.probe).toBe('function');
      expect(typeof a.chat).toBe('function');
    }
    expect(all.awnode.nativeTools).toBe(true);
    expect(all.awdk.nativeTools).toBe(false);
    expect(all.bonsai.nativeTools).toBe(false);
  });
});

describe('Bonsai engine protocol', () => {
  function fakeWorker() {
    let listener: ((e: MessageEvent) => void) | null = null;
    const sent: unknown[] = [];
    const w: WorkerHandle = {
      postMessage: (m) => {
        sent.push(m);
        const msg = m as { type: string; modelId?: string };
        queueMicrotask(() => {
          const reply = (d: unknown) => listener?.({ data: d } as MessageEvent);
          if (msg.type === 'load') {
            reply({ type: 'progress', progress: 50 });
            reply({ type: 'ready', modelId: msg.modelId });
          } else if (msg.type === 'generate') {
            reply({ type: 'token', text: 'hmm', channel: 'thinking' });
            reply({ type: 'token', text: 'Hello' });
            reply({ type: 'done', text: 'Hello' });
          }
        });
      },
      addEventListener: (_t, cb) => {
        listener = cb;
      },
      terminate: vi.fn(),
    };
    return { w, sent };
  }

  it('loads with progress, streams answer tokens only, and resolves done', async () => {
    const { w, sent } = fakeWorker();
    const engine = new BonsaiEngine(async () => w);
    const progress: number[] = [];
    await engine.load('bonsai-1.7b', (p) => progress.push(p));
    expect(progress).toEqual([0.5]);
    expect(engine.ready).toBe(true);
    const tokens: string[] = [];
    const text = await engine.generate([{ role: 'user', content: 'hi' }], { onText: (t) => tokens.push(t) });
    expect(text).toBe('Hello');
    expect(tokens).toEqual(['Hello']);
    expect(sent[1]).toMatchObject({ type: 'generate', messages: [{ role: 'user', content: 'hi' }] });
  });

  it('latches device-lost and refuses to retry', async () => {
    const w: WorkerHandle = {
      postMessage: () => queueMicrotask(() => cb?.({ data: { type: 'error', message: 'lost', fatal: 'device-lost' } } as MessageEvent)),
      addEventListener: (_t, c) => {
        cb = c;
      },
      terminate: vi.fn(),
    };
    let cb: ((e: MessageEvent) => void) | null = null;
    const engine = new BonsaiEngine(async () => w);
    await expect(engine.load('bonsai-1.7b')).rejects.toThrow(/device lost/i);
    expect(engine.lost).toBe(true);
    await expect(engine.load('bonsai-1.7b')).rejects.toThrow(/reload the page/);
  });

  it('pins the engine URL to its sha256 prefix and hashes correctly', async () => {
    expect(BONSAI_ENGINE_URL).toMatch(/^https:\/\/weights\.aitherium\.com\/awbonsai-engine-c6413da0d528\.js$/);
    const abc = new TextEncoder().encode('abc');
    expect(await sha256Hex(abc.buffer.slice(abc.byteOffset, abc.byteOffset + abc.byteLength) as ArrayBuffer)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('hosted proxy route + CSP', () => {
  it('rejects unknown paths, wrong verbs and missing keys before any upstream call', async () => {
    const { GET, POST } = await import('@/app/api/agent-llm/[...path]/route');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const p = (path: string[]) => ({ params: Promise.resolve({ path }) });
    expect((await GET(new NextRequest('http://x/api/agent-llm/hosted/v1/secrets'), p(['hosted', 'v1', 'secrets']))).status).toBe(404);
    expect((await GET(new NextRequest('http://x/'), p(['hosted', 'v1', 'chat', 'completions']))).status).toBe(405);
    expect((await GET(new NextRequest('http://x/'), p(['hosted', 'v1', 'models']))).status).toBe(401);
    const bad = new NextRequest('http://x/', { method: 'POST', headers: { authorization: 'Bearer aither_sk_12345678', 'content-type': 'text/plain' }, body: 'x' });
    expect((await POST(bad, p(['hosted', 'v1', 'chat', 'completions']))).status).toBe(415);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('forwards the bearer to the fixed upstream', async () => {
    const { GET } = await import('@/app/api/agent-llm/[...path]/route');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(200, { data: [] }));
    const req = new NextRequest('http://x/', { headers: { authorization: 'Bearer aither_sk_12345678' } });
    const res = await GET(req, { params: Promise.resolve({ path: ['hosted', 'v1', 'models'] }) });
    expect(res.status).toBe(200);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://mcp.aitherium.com/v1/models');
    expect((fetchSpy.mock.calls[0][1]!.headers as Record<string, string>).Authorization).toBe('Bearer aither_sk_12345678');
    fetchSpy.mockRestore();
  });

  it('agent-llm is same-origin only, and prod CSP admits the local daemons but not backend ports', () => {
    const cross = new NextRequest('http://localhost/api/agent-llm/hosted/v1/models', {
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    expect(proxy(cross).status).toBe(403);
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const csp = proxy(new NextRequest('http://localhost/')).headers.get('Content-Security-Policy') ?? '';
      const connect = /connect-src\s+([^;]+)/.exec(csp)?.[1] ?? '';
      for (const port of ['9001', '8090', '11434']) expect(connect).toContain(`http://127.0.0.1:${port}`);
      expect(connect).not.toContain('http://127.0.0.1:8000');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
