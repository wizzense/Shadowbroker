/**
 * The five chat backends. Each is a real adapter with a health probe; where a
 * backend cannot serve this page today, the probe says exactly why and what
 * change on the OTHER side fixes it (measured against the daemon sources
 * 2026-10-30, see the comments per adapter).
 */
import { createOpenAICompatAdapter } from './openaiCompat';
import { toPromptedMessages } from './promptedTools';
import { BONSAI_MODELS, bonsaiSupport, type BonsaiEngine } from './bonsaiEngine';
import { getSecret } from './settings';
import type { AdapterHealth, AdapterId, ChatRequest, ChatTurn, FetchLike, ModelAdapter } from './types';

export const AWDK_URL = 'http://127.0.0.1:9001';
export const AWNODE_URL = 'http://127.0.0.1:8090';
export const GOBBONET_URL = 'http://127.0.0.1:11434';
/** Same-origin server proxy to the hosted OpenAI-compatible plane (app/api/agent-llm). */
export const HOSTED_PROXY = '/api/agent-llm/hosted';

export interface AdapterDeps {
  fetchImpl?: FetchLike;
  getToken?: (id: AdapterId) => string;
  bonsai?: BonsaiEngine | null;
}

/**
 * awdk daemon (:9001). CORS: online daemons admit any https://<one-label>.aitherium.com
 * by rule and answer Private-Network-Access preflights. Auth: when AITHER_LOCAL_AUTH is
 * off and no AITHER_SERVER_API_KEY is set, a loopback browser needs no token; otherwise
 * paste the daemon's AITHER_SERVER_API_KEY (Bearer). A browser-pair token (`abt_`,
 * scope `node`) forces `plain` completions, which DROP `tools` — so this adapter
 * always uses prompted tool calling and sends `plain: true` (the daemon's own agent
 * loop would run ITS tools, not the board's).
 */
export function awdkAdapter(deps: AdapterDeps = {}): ModelAdapter {
  return createOpenAICompatAdapter({
    id: 'awdk',
    label: 'Local awdk daemon',
    baseUrl: AWDK_URL,
    nativeTools: false,
    extraBody: { plain: true },
    healthPath: '/health',
    getToken: () => (deps.getToken ?? getSecret)('awdk'),
    fetchImpl: deps.fetchImpl,
    blockedHint:
      'awdk on :9001 is not running, or refused this origin (offline mode narrows CORS to loopback; set AITHER_CORS_ORIGINS or go online).',
    authHint:
      'awdk requires a credential: paste AITHER_SERVER_API_KEY, or run with AITHER_LOCAL_AUTH=off. (Its daemon-token header is not CORS-allowed for pages.)',
    credential: {
      label: 'awdk bearer',
      placeholder: 'AITHER_SERVER_API_KEY or abt_ browser token',
      help: 'Kept in this tab only (sessionStorage).',
    },
  });
}

/**
 * awnode gateway (:8090). Passes `tools` through to llama.cpp/vLLM, so native tool
 * calling works once reachable. TODAY IT IS NOT: its CSRF/CORS gate admits only an
 * exact first-party list (no shadowbroker.aitherium.com) and it adds the PNA header
 * only on /health. Needs AITHERNODE_ALLOWED_ORIGINS=https://shadowbroker.aitherium.com
 * AND the PNA middleware extended to /v1/* for allowlisted origins (awnode change).
 */
export function awnodeAdapter(deps: AdapterDeps = {}): ModelAdapter {
  return createOpenAICompatAdapter({
    id: 'awnode',
    label: 'awnode gateway',
    baseUrl: AWNODE_URL,
    nativeTools: true,
    healthPath: '/health',
    getToken: () => (deps.getToken ?? getSecret)('awnode'),
    fetchImpl: deps.fetchImpl,
    blockedHint:
      'awnode on :8090 is down or refuses this origin: set AITHERNODE_ALLOWED_ORIGINS=https://shadowbroker.aitherium.com (its PNA header also covers /health only).',
    authHint: 'awnode wants a loopback caller or the enrolled bearer token.',
    credential: {
      label: 'awnode bearer',
      placeholder: 'enrolled node bearer (remote use only)',
      help: 'Loopback needs none. Kept in this tab only.',
    },
  });
}

/** Aitherium hosted OpenAI-compatible plane (mcp.aitherium.com/v1) via the same-origin proxy. */
export function hostedAdapter(deps: AdapterDeps = {}): ModelAdapter {
  return createOpenAICompatAdapter({
    id: 'hosted',
    label: 'Aitherium hosted',
    baseUrl: HOSTED_PROXY,
    nativeTools: true,
    getToken: () => (deps.getToken ?? getSecret)('hosted'),
    fetchImpl: deps.fetchImpl,
    defaultModel: 'aither-orchestrator',
    blockedHint: 'The ShadowBroker server could not reach its hosted-model proxy.',
    authHint: 'Paste your Aitherium API key (aither_sk_…) in settings.',
    credential: {
      label: 'Aitherium API key',
      placeholder: 'aither_sk_…',
      help: 'Sent only to this site\'s proxy, which forwards it to mcp.aitherium.com. Tab-only storage.',
    },
  });
}

/**
 * GobboNet. gobbonet.aitherium.com is deliberately dead (tunnel answers 404), so the
 * hosted GobboNet is not an endpoint; GobboNet's local server (`adk gobbonet`, :11434)
 * speaks OpenAI /v1. Prompted tools: its llama.cpp backend may run without --jinja.
 */
export function gobbonetAdapter(deps: AdapterDeps = {}): ModelAdapter {
  return createOpenAICompatAdapter({
    id: 'gobbonet',
    label: 'GobboNet (local)',
    baseUrl: GOBBONET_URL,
    nativeTools: false,
    getToken: () => (deps.getToken ?? getSecret)('gobbonet'),
    fetchImpl: deps.fetchImpl,
    blockedHint:
      'GobboNet on :11434 is not running or sends no CORS header for this origin (start `adk gobbonet`; hosted gobbonet.aitherium.com is retired).',
    authHint: 'GobboNet refused the request (401/403).',
  });
}

/** In-browser Bonsai (WebGPU). Prompted tools; the engine runs on this tab's GPU. */
export function bonsaiAdapter(engine: BonsaiEngine | null | undefined): ModelAdapter {
  return {
    id: 'bonsai',
    label: 'Bonsai in browser (WebGPU)',
    nativeTools: false,
    async probe(): Promise<AdapterHealth> {
      if (engine?.lost) return { state: 'down', detail: 'GPU device lost earlier; reload the page.' };
      if (engine?.ready) return { state: 'ok', detail: `${engine.loadedModel} loaded`, models: [engine.loadedModel!] };
      const s = await bonsaiSupport();
      if (!s.ok) return { state: 'unsupported', detail: s.reason };
      return {
        state: 'idle',
        detail: `Not loaded. Press "Load Bonsai" (${BONSAI_MODELS[0].sizeMb} MB download, cached after).`,
        models: BONSAI_MODELS.map((m) => m.id),
      };
    },
    async chat(req: ChatRequest): Promise<ChatTurn> {
      if (!engine?.ready) throw new Error('Bonsai is not loaded — press "Load Bonsai" first.');
      const text = await engine.generate(toPromptedMessages(req.messages), { onText: req.onText, signal: req.signal });
      return { content: text, toolCalls: [] };
    },
  };
}

export function createAdapters(deps: AdapterDeps = {}): Record<AdapterId, ModelAdapter> {
  return {
    awdk: awdkAdapter(deps),
    awnode: awnodeAdapter(deps),
    hosted: hostedAdapter(deps),
    gobbonet: gobbonetAdapter(deps),
    bonsai: bonsaiAdapter(deps.bonsai),
  };
}

export const ADAPTER_ORDER: AdapterId[] = ['awdk', 'awnode', 'hosted', 'gobbonet', 'bonsai'];
