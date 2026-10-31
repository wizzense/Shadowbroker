/**
 * In-browser Bonsai via WebGPU.
 *
 * Licensing: AitherOS's `@aitherium/awbonsai` package is BUSL-1.1 and this repo
 * is AGPL-3.0, so its source is NOT vendored here. This is an independent client
 * for the engine's documented wire protocol
 *   host -> worker: load {modelId} | generate {messages, ...} | interrupt
 *   worker -> host: progress | ready | token {text, channel} | done {text} | error {message, fatal?}
 * loading the same content-addressed engine awbonsai pins, at runtime, from the
 * Aitherium weight mirror (CORS `*`, immutable). The bytes are sha256-checked
 * before anything runs, then started from a Blob URL (cross-origin `new Worker`
 * is refused by browsers). The engine downloads the model GGUF itself.
 *
 * Nothing is fetched until the operator presses "Load Bonsai" — that press is
 * the consent for a multi-hundred-MB download. Mobile is refused (a reclaimed
 * background tab kills the worker silently), and a `device-lost` error is never
 * retried (on Windows it is a display-driver reset; retrying flashes the screen).
 */

/** Engine pinned by awbonsai 0.2.0 (DEFAULT_WORKER_SCRIPT_SHA256); re-measured 2026-10-30. */
export const BONSAI_ENGINE_SHA256 = 'c6413da0d528d8753470b4ce77541c7643a825f1d635d3e0c19132b4e8d7b8d5';
export const BONSAI_ENGINE_URL = `https://weights.aitherium.com/awbonsai-engine-${BONSAI_ENGINE_SHA256.slice(0, 12)}.js`;

export const BONSAI_MODELS = [
  { id: 'bonsai-1.7b', label: 'Bonsai 1.7B', sizeMb: 236 },
  { id: 'bonsai-4b', label: 'Bonsai 4B', sizeMb: 545 },
  { id: 'bonsai-8b', label: 'Bonsai 8B', sizeMb: 1104 },
] as const;

export type BonsaiMessage = { role: 'system' | 'user' | 'assistant'; content: string };

type EngineOut =
  | { type: 'progress'; progress?: number; file?: string }
  | { type: 'ready'; modelId: string }
  | { type: 'token'; text: string; channel?: 'thinking' | 'answer' | 'tool' }
  | { type: 'done'; text: string; tokensPerSecond?: number }
  | { type: 'error'; message: string; fatal?: 'device-lost' }
  | { type: string };

export interface WorkerHandle {
  postMessage(msg: unknown): void;
  addEventListener(type: 'message', cb: (e: MessageEvent) => void): void;
  terminate(): void;
}

export type SpawnWorker = () => Promise<WorkerHandle>;

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** WebGPU capability check. Downloads nothing. */
export async function bonsaiSupport(nav: Navigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined): Promise<{ ok: boolean; reason: string }> {
  if (!nav) return { ok: false, reason: 'not in a browser' };
  const ua = nav.userAgent || '';
  const iPadDesktopUa = /Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
  if (/Android|iPhone|iPad|Mobi/i.test(ua) || iPadDesktopUa) {
    return { ok: false, reason: 'mobile browsers kill the model worker in the background; use a desktop browser' };
  }
  const gpu = (nav as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
  if (!gpu) return { ok: false, reason: 'WebGPU is not available in this browser (Chrome/Edge 113+ desktop)' };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: 'WebGPU found no usable GPU adapter' };
  } catch {
    return { ok: false, reason: 'WebGPU adapter request failed' };
  }
  return { ok: true, reason: 'WebGPU available' };
}

/** Fetch the pinned engine, verify its hash, start it from a Blob URL. */
export function defaultSpawn(fetchImpl: typeof fetch = fetch): SpawnWorker {
  return async () => {
    const res = await fetchImpl(BONSAI_ENGINE_URL, { mode: 'cors', cache: 'force-cache' });
    if (!res.ok) throw new Error(`engine download failed: HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    const actual = await sha256Hex(bytes);
    if (actual !== BONSAI_ENGINE_SHA256) {
      throw new Error(`engine integrity check failed (expected ${BONSAI_ENGINE_SHA256.slice(0, 12)}, got ${actual.slice(0, 12)})`);
    }
    const source = new TextDecoder().decode(bytes);
    const isModule = /(^|[;\n}])\s*(import\s*[\w${*"']|export\s*[\w${*])/.test(source);
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
      return new Worker(url, isModule ? { type: 'module' } : undefined) as unknown as WorkerHandle;
    } finally {
      // The worker has its own reference once constructed.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
  };
}

type Pending = {
  kind: 'load' | 'generate';
  resolve: (v: string) => void;
  reject: (e: Error) => void;
  onText?: (d: string) => void;
  onProgress?: (p: number) => void;
};

export class BonsaiEngine {
  private worker: WorkerHandle | null = null;
  private pending: Pending | null = null;
  private deviceLost = false;
  loadedModel: string | null = null;

  constructor(private readonly spawn: SpawnWorker = defaultSpawn()) {}

  get ready(): boolean {
    return this.loadedModel !== null && !this.deviceLost;
  }

  get lost(): boolean {
    return this.deviceLost;
  }

  private onMessage = (e: MessageEvent) => {
    const msg = e.data as EngineOut;
    const p = this.pending;
    if (!msg || typeof msg !== 'object' || !p) return;
    switch (msg.type) {
      case 'progress': {
        const raw = (msg as { progress?: number }).progress;
        if (typeof raw === 'number') p.onProgress?.(raw > 1 ? raw / 100 : raw);
        break;
      }
      case 'ready':
        if (p.kind === 'load') {
          this.loadedModel = (msg as { modelId: string }).modelId;
          this.pending = null;
          p.resolve(this.loadedModel);
        }
        break;
      case 'token': {
        const t = msg as { text: string; channel?: string };
        if (p.kind === 'generate' && (!t.channel || t.channel === 'answer')) p.onText?.(t.text);
        break;
      }
      case 'done':
        if (p.kind === 'generate') {
          this.pending = null;
          p.resolve((msg as { text: string }).text ?? '');
        }
        break;
      case 'error': {
        const err = msg as { message: string; fatal?: string };
        if (err.fatal === 'device-lost') {
          this.deviceLost = true;
          this.loadedModel = null;
          this.dispose();
        }
        this.pending = null;
        p.reject(new Error(err.fatal === 'device-lost'
          ? 'GPU device lost (driver reset). Not retrying; reload the page to try again.'
          : err.message || 'engine error'));
        break;
      }
      default:
        break;
    }
  };

  async load(modelId: string, onProgress?: (p: number) => void): Promise<string> {
    if (this.deviceLost) throw new Error('GPU device was lost earlier; reload the page before retrying');
    if (this.pending) throw new Error('Bonsai is busy');
    if (!this.worker) {
      this.worker = await this.spawn();
      this.worker.addEventListener('message', this.onMessage);
    }
    return new Promise<string>((resolve, reject) => {
      this.pending = { kind: 'load', resolve, reject, onProgress };
      this.worker!.postMessage({ type: 'load', modelId });
    });
  }

  generate(messages: BonsaiMessage[], opts: { onText?: (d: string) => void; signal?: AbortSignal } = {}): Promise<string> {
    if (!this.ready || !this.worker) return Promise.reject(new Error('Bonsai is not loaded'));
    if (this.pending) return Promise.reject(new Error('Bonsai is busy'));
    return new Promise<string>((resolve, reject) => {
      this.pending = { kind: 'generate', resolve, reject, onText: opts.onText };
      opts.signal?.addEventListener('abort', () => this.worker?.postMessage({ type: 'interrupt' }), { once: true });
      this.worker!.postMessage({
        type: 'generate',
        messages,
        maxTokens: 1024,
        temperature: 0.4,
        reasoningBudget: 256,
      });
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    if (!this.deviceLost) this.loadedModel = null;
  }
}
