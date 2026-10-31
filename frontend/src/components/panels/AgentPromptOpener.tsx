'use client';

/**
 * Reopens (un-closes, expands, raises) the agent chat panel when something on
 * the board hands it a prompt — see `lib/agentChat/prompt.ts`. Renders nothing.
 */
import { useEffect } from 'react';
import { usePanelWorkspace } from '@/components/panels/PanelWorkspace';
import { bringToFront, patchPanel } from '@/lib/panelLayout';
import { AGENT_CHAT_PANEL_ID, AGENT_PROMPT_EVENT } from '@/lib/agentChat/prompt';

export default function AgentPromptOpener({ panelId = AGENT_CHAT_PANEL_ID }: { panelId?: string }) {
  const { update } = usePanelWorkspace();
  useEffect(() => {
    const open = () =>
      update((l) => bringToFront(patchPanel(l, panelId, { closed: false, minimized: false }), panelId));
    window.addEventListener(AGENT_PROMPT_EVENT, open);
    return () => window.removeEventListener(AGENT_PROMPT_EVENT, open);
  }, [update, panelId]);
  return null;
}
