/**
 * WebMCP bridge: expose the ToolRegistry through `navigator.modelContext` so a
 * browser-resident agent (Chrome's WebMCP preview, the MCP-B polyfill, or an
 * extension) can call the same tools as the in-page chat.
 *
 * API shape (W3C Web Machine Learning CG "WebMCP" explainer, Chrome early
 * preview behind chrome://flags "WebMCP for testing"):
 *   navigator.modelContext.registerTool({ name, description, inputSchema,
 *       execute(input, client) -> Promise<{ content: [{ type: 'text', text }] }>,
 *       annotations?: { readOnlyHint } })          // may return { unregister() }
 *   navigator.modelContext.unregisterTool(name)
 *   navigator.modelContext.provideContext({ tools: [...] })  // replaces the set
 *   navigator.modelContext.clearContext()
 * Both registration styles are feature-detected; when neither exists this is a no-op.
 */
import type { ToolRegistry } from './registry';

export interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: object;
  annotations?: { readOnlyHint?: boolean; title?: string };
  execute: (input: unknown, client?: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
}

export interface ModelContextLike {
  registerTool?: (tool: WebMcpTool) => unknown;
  unregisterTool?: (name: string) => unknown;
  provideContext?: (ctx: { tools: WebMcpTool[] }) => unknown;
  clearContext?: () => unknown;
}

export type WebMcpMode = 'registerTool' | 'provideContext' | 'unavailable';

export function getModelContext(nav: unknown = typeof navigator !== 'undefined' ? navigator : undefined): ModelContextLike | null {
  const mc = (nav as { modelContext?: unknown } | undefined)?.modelContext;
  if (!mc || typeof mc !== 'object') return null;
  const m = mc as ModelContextLike;
  return typeof m.registerTool === 'function' || typeof m.provideContext === 'function' ? m : null;
}

/** Convert the registry into WebMCP tool descriptors (results as MCP text content). */
export function toWebMcpTools(registry: ToolRegistry): WebMcpTool[] {
  return registry.list().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: tool.readOnly, title: tool.name.replace(/_/g, ' ') },
    async execute(input: unknown) {
      const res = await registry.call(tool.name, input);
      const text = JSON.stringify(res.ok ? res.result : { error: res.error });
      return { content: [{ type: 'text' as const, text }], ...(res.ok ? {} : { isError: true }) };
    },
  }));
}

/**
 * Register every tool with the page's model context. Returns the mode used and a
 * cleanup that removes exactly what was registered (call on unmount).
 */
export function registerWebMcpTools(
  registry: ToolRegistry,
  nav?: unknown,
): { mode: WebMcpMode; count: number; unregister: () => void } {
  const mc = getModelContext(nav);
  if (!mc) return { mode: 'unavailable', count: 0, unregister: () => {} };
  const tools = toWebMcpTools(registry);

  if (typeof mc.registerTool === 'function') {
    const handles: Array<() => void> = [];
    for (const tool of tools) {
      try {
        const h = mc.registerTool(tool) as { unregister?: () => void } | undefined;
        handles.push(() => {
          if (h && typeof h.unregister === 'function') h.unregister();
          else if (typeof mc.unregisterTool === 'function') mc.unregisterTool(tool.name);
        });
      } catch {
        // A tool name already taken (another bundle registered it) must not break the rest.
      }
    }
    return {
      mode: 'registerTool',
      count: handles.length,
      unregister: () => handles.forEach((fn) => {
        try { fn(); } catch { /* already gone */ }
      }),
    };
  }

  mc.provideContext!({ tools });
  return {
    mode: 'provideContext',
    count: tools.length,
    unregister: () => {
      try {
        if (typeof mc.clearContext === 'function') mc.clearContext();
        else mc.provideContext!({ tools: [] });
      } catch { /* already gone */ }
    },
  };
}
