/**
 * The agent loop: model turn -> tool calls over the WebMCP registry -> results
 * back to the model, at most `maxRounds` times, then a forced final answer.
 * Works identically for native (OpenAI `tools`) and prompted backends.
 */
import type { ToolRegistry } from '@/lib/webmcp';
import { buildToolPrompt, parseToolCalls } from './promptedTools';
import type { ChatMessage, ChatToolCall, ModelAdapter } from './types';

export const MAX_TOOL_ROUNDS = 8;
/** Tool calls executed per model turn; extra calls get an error result. */
export const MAX_CALLS_PER_ROUND = 6;

export type LoopEvent =
  | { type: 'round'; round: number }
  | { type: 'text'; delta: string }
  | { type: 'assistant'; content: string }
  | { type: 'tool_call'; call: ChatToolCall }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; content: string }
  | { type: 'limit'; rounds: number };

export const SYSTEM_PROMPT = [
  'You are the ShadowBroker map analyst, embedded in a live OSINT map of flights, ships, satellites,',
  'CCTV, news/threat feed, outages, data centers, military bases, SIGINT, civic data (ALPR, data',
  'centers, federal spending) and more. Answer from tool results, never from memory, when the',
  'question is about what is on the map. Start with get_summary or list_layers when unsure what exists.',
  'Use fly_to or show_entity to move the map to what you are describing. Be concise, cite counts and',
  'names from the data, and say plainly when the data does not contain the answer.',
].join(' ');

export interface RunLoopOptions {
  adapter: ModelAdapter;
  registry: ToolRegistry;
  /** Conversation so far INCLUDING the new user message (no system message). */
  history: ChatMessage[];
  model?: string;
  maxRounds?: number;
  signal?: AbortSignal;
  onEvent?: (e: LoopEvent) => void;
}

function systemMessage(adapter: ModelAdapter, registry: ToolRegistry): ChatMessage {
  const content = adapter.nativeTools
    ? SYSTEM_PROMPT
    : `${SYSTEM_PROMPT}\n\n${buildToolPrompt(registry.toOpenAITools())}`;
  return { role: 'system', content };
}

/** Run until the model answers without tool calls. Returns the new messages appended to history. */
export async function runAgentLoop(opts: RunLoopOptions): Promise<ChatMessage[]> {
  const { adapter, registry, signal } = opts;
  const emit = opts.onEvent ?? (() => {});
  const maxRounds = Math.max(1, Math.min(opts.maxRounds ?? MAX_TOOL_ROUNDS, MAX_TOOL_ROUNDS));
  const added: ChatMessage[] = [];
  const convo = (): ChatMessage[] => [systemMessage(adapter, registry), ...opts.history, ...added];
  const tools = adapter.nativeTools ? registry.toOpenAITools() : undefined;

  for (let round = 1; round <= maxRounds + 1; round += 1) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const final = round > maxRounds;
    if (final) {
      emit({ type: 'limit', rounds: maxRounds });
      added.push({ role: 'user', content: 'Tool budget exhausted. Answer now with what you have; do not call tools.' });
    }
    emit({ type: 'round', round });
    const turn = await adapter.chat({
      model: opts.model,
      messages: convo(),
      tools: final ? undefined : tools,
      signal,
      onText: (d) => emit({ type: 'text', delta: d }),
    });

    let calls = turn.toolCalls;
    let content = turn.content;
    if (!adapter.nativeTools) {
      const parsed = parseToolCalls(turn.content);
      calls = parsed.calls;
      content = parsed.text;
    }
    if (final || calls.length === 0) {
      added.push({ role: 'assistant', content });
      emit({ type: 'assistant', content });
      return added;
    }

    added.push({ role: 'assistant', content, tool_calls: calls });
    for (const [i, call] of calls.entries()) {
      emit({ type: 'tool_call', call });
      let payload: string;
      let ok = false;
      if (i >= MAX_CALLS_PER_ROUND) {
        payload = JSON.stringify({ error: `skipped: at most ${MAX_CALLS_PER_ROUND} tool calls per turn` });
      } else {
        let args: unknown = {};
        try {
          args = call.arguments ? JSON.parse(call.arguments) : {};
        } catch {
          args = null;
        }
        if (args === null) {
          payload = JSON.stringify({ error: 'arguments were not valid JSON' });
        } else {
          const res = await registry.call(call.name, args, signal);
          ok = res.ok;
          payload = JSON.stringify(res.ok ? res.result : { error: res.error });
        }
      }
      added.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: payload });
      emit({ type: 'tool_result', id: call.id, name: call.name, ok, content: payload });
    }
  }
  return added;
}
