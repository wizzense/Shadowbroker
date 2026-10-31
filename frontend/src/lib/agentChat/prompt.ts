/**
 * Hand a prompt to the agent chat from anywhere on the board (e.g. the CIVIC
 * panel's "Ask the map about this candidate").
 *
 * The chat panel may not be mounted (its floating panel can be closed), so the
 * request is kept as `pending` until a chat panel consumes it, and an event
 * tells a mounted panel — and the panel workspace, which reopens it — now.
 * The prompt is PREFILLED, never auto-sent: the operator reads it and presses
 * send.
 */

export const AGENT_PROMPT_EVENT = 'sb:agent-prompt';
export const AGENT_CHAT_PANEL_ID = 'agent-chat';

let pending: string | null = null;

export function requestAgentPrompt(text: string): void {
  const t = (text || '').trim().slice(0, 2000);
  if (!t) return;
  pending = t;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(AGENT_PROMPT_EVENT, { detail: t }));
}

/** Take the pending prompt, if any (once). */
export function consumeAgentPrompt(): string | null {
  const t = pending;
  pending = null;
  return t;
}
