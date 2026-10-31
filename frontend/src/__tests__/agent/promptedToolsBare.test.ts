import { describe, expect, it } from 'vitest';
import { parseToolCalls } from '@/lib/agentChat/promptedTools';
import { createShadowbrokerTools, resolveStateCode } from '@/lib/webmcp/tools';

// Bonsai (Qwen3 tokenizer) strips the special <tool_call> token when decoding,
// so its calls arrive as a bare JSON object with only a stray closing tag. The
// owner saw that text printed in the chat instead of the tool running.
describe('prompted tool calls without the opening tag', () => {
  it('parses a bare call followed by a stray </tool_call>', () => {
    const out = parseToolCalls(
      '{"name": "get_entities_in_view", "arguments": {"layer": "civic_alpr", "bbox": [32.77, -96.82, 32.80, -96.78], "limit": 10}}\n</tool_call>',
    );
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0].name).toBe('get_entities_in_view');
    expect(JSON.parse(out.calls[0].arguments).limit).toBe(10);
    expect(out.text).toBe('');
  });

  it('keeps surrounding prose and strips only the call', () => {
    const out = parseToolCalls('Let me check. {"name": "get_elections", "arguments": {"state": "Texas"}}');
    expect(out.calls.map((c) => c.name)).toEqual(['get_elections']);
    expect(out.text).toBe('Let me check.');
  });

  it('handles braces inside string values', () => {
    const out = parseToolCalls('{"name": "search_entities", "arguments": {"query": "a {weird} name"}}');
    expect(JSON.parse(out.calls[0].arguments).query).toBe('a {weird} name');
  });

  it('leaves ordinary JSON without a name alone', () => {
    const out = parseToolCalls('The answer is {"total": 3}.');
    expect(out.calls).toHaveLength(0);
    expect(out.text).toBe('The answer is {"total": 3}.');
  });

  it('still parses the tagged form', () => {
    const out = parseToolCalls('<tool_call>{"name": "get_summary", "arguments": {}}</tool_call>');
    expect(out.calls[0].name).toBe('get_summary');
  });
});

describe('civic tools answer "elections in Texas"', () => {
  it('resolves state names and codes', () => {
    expect(resolveStateCode('Texas')).toBe('TX');
    expect(resolveStateCode('tx')).toBe('TX');
    expect(resolveStateCode('new  york')).toBe('NY');
    expect(() => resolveStateCode('Narnia')).toThrow(/state/);
  });

  it('registers the election, officials and local-government tools', () => {
    const names = createShadowbrokerTools().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['get_elections', 'get_officials_at', 'get_local_governments']));
  });

  it('get_elections fetches elections and how-to-vote for the state', async () => {
    const tool = createShadowbrokerTools().find((t) => t.name === 'get_elections')!;
    const urls: string[] = [];
    const ctx = { fetchJson: async (u: string) => { urls.push(u); return { ok: true }; } } as never;
    const out = (await tool.execute({ state: 'Texas' }, ctx, new AbortController().signal)) as { state: string };
    expect(out.state).toBe('TX');
    expect(urls.some((u) => u.includes('/elections?state=TX'))).toBe(true);
    expect(urls.some((u) => u.endsWith('/how-to-vote/TX'))).toBe(true);
  });
});
