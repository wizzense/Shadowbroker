'use client';

/**
 * AgentChatPanel — "just prompt the page". A chat that answers questions about
 * everything on the map through the WebMCP tool registry, backed by a selectable
 * model (local awdk / awnode / hosted Aitherium / GobboNet / Bonsai in-browser).
 *
 * The same registry is published on `navigator.modelContext` (WebMCP) while this
 * component is mounted, so an external browser agent can use the board too.
 *
 * Security: model output renders as React text only (no HTML); tools are
 * read-only except map-view actions; credentials stay in sessionStorage.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Loader2, Send, Settings2, Square, X } from 'lucide-react';
import { readDataStore } from '@/hooks/useDataStore';
import { getLiveDataBounds } from '@/lib/liveDataViewport';
import {
  createShadowbrokerTools,
  registerWebMcpTools,
  ToolRegistry,
  type ToolContext,
  type WebMcpMode,
} from '@/lib/webmcp';
import {
  ADAPTER_ORDER,
  BONSAI_MODELS,
  BonsaiEngine,
  consumeTokenFragment,
  createAdapters,
  getSecret,
  loadPrefs,
  runAgentLoop,
  savePrefs,
  setSecret,
  splitThinking,
  type AdapterHealth,
  type AdapterId,
  type AgentPrefs,
  type ChatMessage,
} from '@/lib/agentChat';
import type { ActiveLayers } from '@/types/dashboard';

export interface AgentChatPanelProps {
  /** Rendered inside a FloatingPanel: fill the shell, always open, no fixed positioning. */
  embedded?: boolean;
  onFlyTo: (lat: number, lng: number, zoom?: number) => void;
  activeLayers: ActiveLayers;
  setActiveLayers: React.Dispatch<React.SetStateAction<ActiveLayers>>;
}

type UiItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; streaming?: boolean }
  | { kind: 'tool'; id: string; name: string; args: string; result?: string; ok?: boolean }
  | { kind: 'error'; text: string };

const DOT: Record<AdapterHealth['state'], string> = {
  ok: 'bg-green-400',
  idle: 'bg-cyan-400',
  auth: 'bg-amber-400',
  loading: 'bg-cyan-300 animate-pulse',
  blocked: 'bg-red-500',
  down: 'bg-red-500',
  unsupported: 'bg-gray-500',
};

const PROBE_TIMEOUT_MS = 4000;
const PROBE_INTERVAL_MS = 30_000;
const MAX_HISTORY = 24;

function ToolItem({ item }: { item: Extract<UiItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-cyan-900/60 rounded bg-black/40 text-[10px] font-mono">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1 px-2 py-1 text-left text-cyan-500 hover:text-cyan-300"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span>{item.name}</span>
        <span className={item.result === undefined ? 'text-gray-500' : item.ok ? 'text-green-500' : 'text-red-400'}>
          {item.result === undefined ? '…' : item.ok ? 'ok' : 'error'}
        </span>
      </button>
      {open && (
        <div className="px-2 pb-2 space-y-1 text-gray-400 whitespace-pre-wrap break-all">
          <div>args: {item.args}</div>
          {item.result !== undefined && <div>result: {item.result.slice(0, 2000)}</div>}
        </div>
      )}
    </div>
  );
}

function AssistantText({ text }: { text: string }) {
  const { thinking, answer } = splitThinking(text);
  return (
    <div className="space-y-1">
      {thinking && (
        <details className="text-[10px] text-gray-500">
          <summary className="cursor-pointer">reasoning</summary>
          <div className="whitespace-pre-wrap">{thinking}</div>
        </details>
      )}
      <div className="whitespace-pre-wrap text-gray-200">{answer}</div>
    </div>
  );
}

export default function AgentChatPanel({ onFlyTo, activeLayers, setActiveLayers, embedded = false }: AgentChatPanelProps) {
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState<AgentPrefs>(() => loadPrefs());
  const [health, setHealth] = useState<Partial<Record<AdapterId, AdapterHealth>>>({});
  const [items, setItems] = useState<UiItem[]>([]);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // Live progress for the turn in flight: phase, started-at and chars generated.
  const [status, setStatus] = useState<{ phase: string; since: number; chars: number } | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [busy]);
  const [showSettings, setShowSettings] = useState(false);
  const [secretDraft, setSecretDraft] = useState('');
  const [webmcp, setWebmcp] = useState<{ mode: WebMcpMode; count: number }>({ mode: 'unavailable', count: 0 });
  const [bonsaiProgress, setBonsaiProgress] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Latest props for the tool context without re-creating the registry each render.
  const flyRef = useRef(onFlyTo);
  flyRef.current = onFlyTo;
  const layersRef = useRef(activeLayers);
  layersRef.current = activeLayers;
  const setLayersRef = useRef(setActiveLayers);
  setLayersRef.current = setActiveLayers;

  const registry = useMemo(() => {
    const ctx: ToolContext = {
      readStore: readDataStore,
      getBounds: getLiveDataBounds,
      getActiveLayers: () => layersRef.current as unknown as Record<string, boolean>,
      map: {
        flyTo: (lat, lng, zoom) => flyRef.current(lat, lng, zoom),
        setLayer: (layer, enabled) =>
          setLayersRef.current((prev) => (layer in prev ? { ...prev, [layer]: enabled } : prev)),
      },
      fetchJson: async (url, signal) => {
        if (!url.startsWith('/')) throw new Error('tools may only fetch same-origin paths');
        const r = await fetch(url, { signal, headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      },
    };
    return new ToolRegistry(createShadowbrokerTools(), ctx);
  }, []);

  const bonsai = useMemo(() => (typeof window !== 'undefined' ? new BonsaiEngine() : null), []);
  const adapters = useMemo(() => createAdapters({ bonsai }), [bonsai]);
  const adapter = adapters[prefs.backend] ?? adapters.awdk;

  // WebMCP: publish the registry for any browser agent while mounted.
  useEffect(() => {
    const reg = registerWebMcpTools(registry);
    setWebmcp({ mode: reg.mode, count: reg.count });
    return () => reg.unregister();
  }, [registry]);

  useEffect(() => {
    const id = consumeTokenFragment();
    if (id) setPrefs((p) => ({ ...p, backend: id }));
    return () => bonsai?.dispose();
  }, [bonsai]);

  useEffect(() => savePrefs(prefs), [prefs]);
  useEffect(() => setSecretDraft(getSecret(prefs.backend)), [prefs.backend]);

  const probe = useCallback(
    async (id: AdapterId) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
      setHealth((h) => ({ ...h, [id]: { state: 'loading', detail: 'checking…' } }));
      try {
        const res = await adapters[id].probe(ctl.signal);
        setHealth((h) => ({ ...h, [id]: res }));
      } finally {
        clearTimeout(timer);
      }
    },
    [adapters],
  );

  useEffect(() => {
    if (!open) return;
    ADAPTER_ORDER.forEach((id) => void probe(id));
    const t = setInterval(() => void probe(prefs.backend), PROBE_INTERVAL_MS);
    return () => clearInterval(t);
  }, [open, probe, prefs.backend]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items]);

  const currentModel = prefs.backend === 'bonsai' ? undefined : prefs.models[prefs.backend];
  const models = health[prefs.backend]?.models ?? [];

  const loadBonsai = async () => {
    if (!bonsai) return;
    setBonsaiProgress(0);
    try {
      await bonsai.load(prefs.bonsaiModel, (p) => setBonsaiProgress(p));
    } catch (e) {
      setItems((it) => [...it, { kind: 'error', text: `Bonsai: ${(e as Error).message}` }]);
    } finally {
      setBonsaiProgress(null);
      void probe('bonsai');
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setBusy(true);
    setStatus({ phase: 'sending to model…', since: Date.now(), chars: 0 });
    const ctl = new AbortController();
    abortRef.current = ctl;
    const userMsg: ChatMessage = { role: 'user', content: text };
    const convo = [...history, userMsg].slice(-MAX_HISTORY);
    setItems((it) => [...it, { kind: 'user', text }, { kind: 'assistant', text: '', streaming: true }]);

    const appendStreaming = (delta: string) =>
      setItems((it) => {
        const last = it[it.length - 1];
        if (last?.kind === 'assistant' && last.streaming) {
          return [...it.slice(0, -1), { ...last, text: last.text + delta }];
        }
        return [...it, { kind: 'assistant', text: delta, streaming: true }];
      });
    const closeStreaming = (finalText?: string) =>
      setItems((it) => {
        const last = it[it.length - 1];
        if (last?.kind === 'assistant' && last.streaming) {
          const t = finalText ?? last.text;
          const shown = splitThinking(t);
          return shown.answer || shown.thinking ? [...it.slice(0, -1), { kind: 'assistant', text: t }] : it.slice(0, -1);
        }
        return it;
      });

    try {
      const added = await runAgentLoop({
        adapter,
        registry,
        history: convo,
        model: currentModel,
        signal: ctl.signal,
        onEvent: (e) => {
          if (e.type === 'text') {
            appendStreaming(e.delta);
            setStatus((st) => (st ? { ...st, phase: 'generating…', chars: st.chars + e.delta.length } : st));
          } else if (e.type === 'round') {
            setStatus((st) => ({
              phase: e.round > 1 ? `round ${e.round}: model reading tool results…` : 'waiting for first token…',
              since: st?.since ?? Date.now(),
              chars: 0,
            }));
            if (e.round > 1) appendStreaming('');
          } else if (e.type === 'tool_call') {
            setStatus((st) => (st ? { ...st, phase: `running tool ${e.call.name}…` } : st));
            closeStreaming();
            setItems((it) => [...it, { kind: 'tool', id: e.call.id, name: e.call.name, args: e.call.arguments }]);
          } else if (e.type === 'tool_result') {
            setItems((it) =>
              it.map((x) => (x.kind === 'tool' && x.id === e.id && x.result === undefined ? { ...x, result: e.content, ok: e.ok } : x)),
            );
          } else if (e.type === 'limit') {
            setItems((it) => [...it, { kind: 'error', text: `tool budget (${e.rounds} rounds) reached; asking for a final answer` }]);
          } else if (e.type === 'assistant') closeStreaming(e.content);
        },
      });
      setHistory([...convo, ...added].slice(-MAX_HISTORY));
    } catch (e) {
      closeStreaming();
      const msg = (e as Error)?.name === 'AbortError' ? 'stopped' : (e as Error)?.message || String(e);
      setItems((it) => [...it, { kind: 'error', text: msg }]);
      // A credential problem: open the credential field right where the error is.
      if (/(401|403)/.test(msg)) setShowSettings(true);
      setHistory(convo);
    } finally {
      setBusy(false);
      setStatus(null);
      abortRef.current = null;
    }
  };

  if (!open && !embedded) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-24 right-4 z-[300] pointer-events-auto flex items-center gap-1.5 px-3 py-2 rounded border border-cyan-700/60 bg-black/80 text-cyan-400 hover:text-cyan-200 text-[10px] font-mono tracking-widest"
        title="Ask the map (agent chat)"
      >
        <Bot size={12} /> ASK THE MAP
      </button>
    );
  }

  const h = health[prefs.backend];
  return (
    <div
      className={
        embedded
          ? 'w-full h-full min-h-[360px] flex flex-col bg-black/90 text-[11px] font-mono'
          : 'fixed bottom-4 right-4 z-[300] pointer-events-auto w-[380px] max-w-[calc(100vw-2rem)] h-[560px] max-h-[calc(100vh-6rem)] flex flex-col rounded border border-cyan-800/60 bg-black/90 backdrop-blur text-[11px] font-mono shadow-xl'
      }
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-cyan-900/60">
        <div className="flex items-center gap-2 text-cyan-400 tracking-widest">
          <Bot size={12} /> AGENT CHAT
          <span className="text-[9px] text-gray-500" title="WebMCP (navigator.modelContext)">
            {webmcp.mode === 'unavailable' ? 'WebMCP: n/a' : `WebMCP: ${webmcp.count} tools`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" aria-label="settings" onClick={() => setShowSettings((s) => !s)} className="text-gray-400 hover:text-cyan-300">
            <Settings2 size={12} />
          </button>
          {!embedded && (
            <button type="button" aria-label="close" onClick={() => setOpen(false)} className="text-gray-400 hover:text-cyan-300">
            <X size={12} />
          </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1 px-2 py-2 border-b border-cyan-900/40">
        {ADAPTER_ORDER.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setPrefs((p) => ({ ...p, backend: id }))}
            title={health[id]?.detail ?? ''}
            className={`flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] ${
              prefs.backend === id ? 'border-cyan-500 text-cyan-300' : 'border-gray-700 text-gray-400 hover:text-gray-200'
            }`}
          >
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${DOT[health[id]?.state ?? 'idle']}`} />
            {adapters[id].label}
          </button>
        ))}
      </div>

      <div className="px-3 py-1.5 border-b border-cyan-900/40 space-y-1">
        <div className="text-[10px] text-gray-400">{h?.detail ?? 'not checked yet'}</div>
        {prefs.backend === 'bonsai' ? (
          <div className="flex items-center gap-2">
            <select
              value={prefs.bonsaiModel}
              onChange={(e) => setPrefs((p) => ({ ...p, bonsaiModel: e.target.value }))}
              disabled={bonsai?.ready || bonsaiProgress !== null}
              className="bg-black border border-gray-700 text-gray-300 text-[10px] px-1 py-0.5"
            >
              {BONSAI_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{`${m.label} (${m.sizeMb} MB)`}</option>
              ))}
            </select>
            {!bonsai?.ready && h?.state !== 'unsupported' && (
              <button
                type="button"
                onClick={() => void loadBonsai()}
                disabled={bonsaiProgress !== null}
                className="px-2 py-0.5 border border-cyan-700 text-cyan-300 rounded text-[10px] disabled:opacity-50"
              >
                {bonsaiProgress !== null ? `Loading ${Math.round(bonsaiProgress * 100)}%` : 'Load Bonsai in browser'}
              </button>
            )}
          </div>
        ) : (
          models.length > 0 && (
            <select
              value={currentModel ?? ''}
              onChange={(e) => setPrefs((p) => ({ ...p, models: { ...p.models, [p.backend]: e.target.value } }))}
              className="w-full bg-black border border-gray-700 text-gray-300 text-[10px] px-1 py-0.5"
            >
              <option value="">default model</option>
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          )
        )}
        {bonsaiProgress !== null && (
          <div className="h-1 bg-gray-800 rounded">
            <div className="h-1 bg-cyan-500 rounded" style={{ width: `${Math.round(bonsaiProgress * 100)}%` }} />
          </div>
        )}
        {(showSettings || h?.state === 'auth') && adapter.credential && (
          <div className="space-y-1 pt-1">
            <label className="block text-[10px] text-gray-400">{adapter.credential.label}</label>
            <div className="flex gap-1">
              <input
                type="password"
                autoComplete="off"
                value={secretDraft}
                placeholder={adapter.credential.placeholder}
                onChange={(e) => setSecretDraft(e.target.value)}
                className="flex-1 bg-black border border-gray-700 text-gray-200 px-1 py-0.5 text-[10px]"
              />
              <button
                type="button"
                onClick={() => {
                  setSecret(prefs.backend, secretDraft);
                  void probe(prefs.backend);
                }}
                className="px-2 border border-cyan-700 text-cyan-300 rounded text-[10px]"
              >
                save
              </button>
            </div>
            <div className="text-[9px] text-gray-500">{adapter.credential.help}</div>
          </div>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {items.length === 0 && (
          <div className="text-gray-500 text-[10px]">
            Ask about anything on the map: “which military flights are over the Black Sea?”, “top threats right now”,
            “ALPR cameras near me”, “fly to the nearest data center”.
          </div>
        )}
        {items.map((item, i) =>
          item.kind === 'user' ? (
            <div key={i} className="text-cyan-200 whitespace-pre-wrap">&gt; {item.text}</div>
          ) : item.kind === 'assistant' ? (
            <AssistantText key={i} text={item.text} />
          ) : item.kind === 'tool' ? (
            <ToolItem key={i} item={item} />
          ) : (
            <div key={i} className="text-red-400 whitespace-pre-wrap">{item.text}</div>
          ),
        )}
        {busy && (
          <div className="flex items-center gap-1.5 text-[10px] text-cyan-500" role="status" aria-live="polite">
            <Loader2 size={12} className="animate-spin" />
            <span>{status?.phase ?? 'working…'}</span>
            {status && (
              <span className="text-gray-500">
                {Math.round((Date.now() - status.since) / 1000)}s
                {status.chars > 0 ? ` · ${status.chars} chars` : ''}
              </span>
            )}
          </div>
        )}
      </div>

      <form
        className="flex gap-1 p-2 border-t border-cyan-900/60"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          maxLength={4000}
          placeholder="Ask the map…"
          className="flex-1 resize-none bg-black border border-gray-700 text-gray-200 px-2 py-1 text-[11px]"
        />
        {busy ? (
          <button type="button" aria-label="stop" onClick={() => abortRef.current?.abort()} className="px-2 border border-red-700 text-red-400 rounded">
            <Square size={12} />
          </button>
        ) : (
          <button type="submit" aria-label="send" className="px-2 border border-cyan-700 text-cyan-300 rounded">
            <Send size={12} />
          </button>
        )}
      </form>
    </div>
  );
}
