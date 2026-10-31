/**
 * Prompted tool calling for backends that cannot take OpenAI `tools`:
 * the awdk daemon (a browser token forces `plain` completions, which drop tools)
 * and in-browser Bonsai. Tools are described in the system prompt and the model
 * answers with `<tool_call>{"name": ..., "arguments": {...}}</tool_call>` — the
 * same tag Qwen3-family models (Bonsai) are trained to emit.
 */
import type { OpenAIToolSpec } from '@/lib/webmcp';
import type { ChatMessage, ChatToolCall } from './types';

export function buildToolPrompt(tools: OpenAIToolSpec[]): string {
  const lines = tools.map((t) => {
    const props = Object.entries(t.function.parameters.properties)
      .map(([k, p]) => `${k}: ${p.type}${(t.function.parameters.required ?? []).includes(k) ? ' (required)' : ''}`)
      .join(', ');
    return `- ${t.function.name}(${props}) — ${t.function.description}`;
  });
  return [
    'You can call tools. To call one, reply with ONLY this block (one or more), nothing else:',
    '<tool_call>{"name": "TOOL_NAME", "arguments": {"arg": "value"}}</tool_call>',
    'You will receive the result as TOOL_RESULT. When you have enough information, answer normally without any tool_call block.',
    'Tools:',
    ...lines,
  ].join('\n');
}

const TAGGED = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
const FENCED = /```(?:tool_call|json)?\s*(\{[\s\S]*?"name"[\s\S]*?\})\s*```/g;

function parseOne(raw: string, n: number): ChatToolCall | null {
  try {
    const obj = JSON.parse(raw) as { name?: unknown; arguments?: unknown; parameters?: unknown };
    if (typeof obj.name !== 'string' || !obj.name) return null;
    const args = obj.arguments ?? obj.parameters ?? {};
    return {
      id: `call_p${n}`,
      name: obj.name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    };
  } catch {
    return null;
  }
}

/** Extract tool calls from model text; `text` is what remains for display. */
export function parseToolCalls(content: string): { calls: ChatToolCall[]; text: string } {
  const calls: ChatToolCall[] = [];
  let text = content.replace(TAGGED, (_m, body: string) => {
    const c = parseOne(body, calls.length);
    if (c) calls.push(c);
    return '';
  });
  if (calls.length === 0) {
    text = text.replace(FENCED, (m, body: string) => {
      const c = parseOne(body, calls.length);
      if (c) {
        calls.push(c);
        return '';
      }
      return m;
    });
  }
  return { calls, text: text.trim() };
}

/**
 * Re-encode a native tool conversation for a text-only backend: assistant tool
 * calls become their `<tool_call>` text, tool results become user turns.
 */
export function toPromptedMessages(messages: ChatMessage[]): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'user' as const, content: `TOOL_RESULT ${m.name}: ${m.content}` };
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const calls = m.tool_calls
        .map((c) => `<tool_call>{"name": ${JSON.stringify(c.name)}, "arguments": ${c.arguments || '{}'}}</tool_call>`)
        .join('\n');
      return { role: 'assistant' as const, content: [m.content, calls].filter(Boolean).join('\n') };
    }
    return { role: m.role, content: m.content };
  });
}
