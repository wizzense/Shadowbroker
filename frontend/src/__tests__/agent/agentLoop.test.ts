/**
 * The agent loop against fake models: native tool calls, prompted tool calls,
 * the round cap with a forced final answer, bad JSON arguments, and abort.
 */
import { describe, expect, it, vi } from 'vitest';
import { createShadowbrokerTools, ToolRegistry, type ToolContext } from '@/lib/webmcp';
import { runAgentLoop, MAX_TOOL_ROUNDS, type LoopEvent } from '@/lib/agentChat/loop';
import type { ChatRequest, ChatTurn, ModelAdapter } from '@/lib/agentChat/types';

function registry() {
  const flyTo = vi.fn();
  const ctx: ToolContext = {
    readStore: () => ({ military_flights: [{ callsign: 'RCH123', lat: 44, lng: 33 }], news: [] }),
    getBounds: () => null,
    getActiveLayers: () => ({ military: true }),
    map: { flyTo, setLayer: vi.fn() },
    fetchJson: vi.fn(),
  };
  return { reg: new ToolRegistry(createShadowbrokerTools(), ctx), flyTo };
}

function fakeAdapter(nativeTools: boolean, script: Array<(req: ChatRequest) => ChatTurn>): ModelAdapter & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let i = 0;
  return {
    id: 'awnode',
    label: 'fake',
    nativeTools,
    requests,
    probe: async () => ({ state: 'ok', detail: '' }),
    chat: async (req) => {
      requests.push(req);
      const turn = script[Math.min(i, script.length - 1)](req);
      i += 1;
      req.onText?.(turn.content);
      return turn;
    },
  };
}

describe('runAgentLoop', () => {
  it('native: calls tools, feeds results back, then answers', async () => {
    const { reg, flyTo } = registry();
    const adapter = fakeAdapter(true, [
      () => ({ content: '', toolCalls: [{ id: 'c1', name: 'search_entities', arguments: '{"query":"RCH"}' }, { id: 'c2', name: 'fly_to', arguments: '{"lat":44,"lng":33,"zoom":6}' }] }),
      () => ({ content: 'RCH123 is a military flight over the Black Sea.', toolCalls: [] }),
    ]);
    const events: LoopEvent[] = [];
    const added = await runAgentLoop({ adapter, registry: reg, history: [{ role: 'user', content: 'where is RCH123?' }], onEvent: (e) => events.push(e) });
    expect(flyTo).toHaveBeenCalledWith(44, 33, 6);
    expect(added.map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'assistant']);
    expect(adapter.requests[0].tools?.length).toBeGreaterThan(0);
    expect(adapter.requests[0].messages[0].role).toBe('system');
    const second = adapter.requests[1].messages;
    const toolMsg = second.find((m) => m.role === 'tool' && m.tool_call_id === 'c1');
    expect(toolMsg && 'content' in toolMsg ? toolMsg.content : '').toContain('RCH123');
    expect(events.filter((e) => e.type === 'tool_result').every((e) => e.type === 'tool_result' && e.ok)).toBe(true);
    expect(added[added.length - 1]).toEqual({ role: 'assistant', content: 'RCH123 is a military flight over the Black Sea.' });
  });

  it('prompted: tools described in the system prompt and parsed from text', async () => {
    const { reg } = registry();
    const adapter = fakeAdapter(false, [
      () => ({ content: '<tool_call>{"name": "get_summary", "arguments": {}}</tool_call>', toolCalls: [] }),
      () => ({ content: 'There is 1 military flight.', toolCalls: [] }),
    ]);
    const added = await runAgentLoop({ adapter, registry: reg, history: [{ role: 'user', content: 'summary?' }] });
    expect(adapter.requests[0].tools).toBeUndefined();
    expect(adapter.requests[0].messages[0].content).toContain('<tool_call>');
    expect(added[1]).toMatchObject({ role: 'tool', name: 'get_summary' });
    expect(added[added.length - 1]).toMatchObject({ role: 'assistant', content: 'There is 1 military flight.' });
  });

  it('stops after the round cap and forces a final answer without tools', async () => {
    const { reg } = registry();
    const adapter = fakeAdapter(true, [
      (req) => (req.tools ? { content: '', toolCalls: [{ id: 'x', name: 'get_summary', arguments: '{}' }] } : { content: 'final', toolCalls: [] }),
    ]);
    const events: LoopEvent[] = [];
    const added = await runAgentLoop({ adapter, registry: reg, history: [{ role: 'user', content: 'loop' }], onEvent: (e) => events.push(e) });
    expect(adapter.requests).toHaveLength(MAX_TOOL_ROUNDS + 1);
    expect(adapter.requests[MAX_TOOL_ROUNDS].tools).toBeUndefined();
    expect(events.some((e) => e.type === 'limit')).toBe(true);
    expect(added[added.length - 1]).toEqual({ role: 'assistant', content: 'final' });
  });

  it('reports bad JSON arguments and unknown tools as tool errors, not crashes', async () => {
    const { reg } = registry();
    const adapter = fakeAdapter(true, [
      () => ({ content: '', toolCalls: [{ id: 'a', name: 'get_entity', arguments: '{bad' }, { id: 'b', name: 'rm_rf', arguments: '{}' }] }),
      () => ({ content: 'ok', toolCalls: [] }),
    ]);
    const added = await runAgentLoop({ adapter, registry: reg, history: [{ role: 'user', content: 'x' }] });
    const tools = added.filter((m) => m.role === 'tool').map((m) => ('content' in m ? m.content : ''));
    expect(tools[0]).toContain('not valid JSON');
    expect(tools[1]).toContain('unknown tool');
  });

  it('honours abort', async () => {
    const { reg } = registry();
    const ctl = new AbortController();
    ctl.abort();
    const adapter = fakeAdapter(true, [() => ({ content: 'x', toolCalls: [] })]);
    await expect(runAgentLoop({ adapter, registry: reg, history: [], signal: ctl.signal })).rejects.toThrow(/aborted/);
  });
});
