/**
 * Agent chat types. Messages follow the OpenAI Chat Completions shape so one
 * loop drives every backend; adapters without native tool calling get the same
 * conversation re-encoded as plain text (see promptedTools.ts).
 */
import type { OpenAIToolSpec } from '@/lib/webmcp';

export interface ChatToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments, exactly as the model produced them. */
  arguments: string;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; name: string; content: string };

export type HealthState = 'ok' | 'auth' | 'blocked' | 'down' | 'idle' | 'loading' | 'unsupported';

export interface AdapterHealth {
  state: HealthState;
  /** One human sentence: what is wrong and what fixes it. */
  detail: string;
  models?: string[];
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  /** Present only when the adapter supports native tool calling. */
  tools?: OpenAIToolSpec[];
  signal?: AbortSignal;
  /** Streamed answer text as it arrives. */
  onText?: (delta: string) => void;
}

export interface ChatTurn {
  content: string;
  toolCalls: ChatToolCall[];
}

export interface ModelAdapter {
  id: AdapterId;
  label: string;
  /** true: send OpenAI `tools`; false: tools are described in the prompt and parsed from text. */
  nativeTools: boolean;
  /** Which secret (if any) the settings form should offer for this backend. */
  credential?: { label: string; placeholder: string; help: string };
  probe(signal?: AbortSignal): Promise<AdapterHealth>;
  chat(req: ChatRequest): Promise<ChatTurn>;
}

export type AdapterId = 'awdk' | 'awnode' | 'hosted' | 'gobbonet' | 'bonsai';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
