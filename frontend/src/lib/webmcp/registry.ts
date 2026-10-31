/**
 * ToolRegistry — one place that validates arguments, runs a tool, and bounds +
 * redacts its result. Both WebMCP and the in-page agent call tools through
 * `call()`, so a foreign browser agent gets exactly the same guarantees.
 */
import { boundResult, redactDeep } from './bound';
import type { JsonSchemaProperty, ToolCallResult, ToolContext, ToolDefinition } from './types';

/** OpenAI Chat Completions `tools` entry. */
export interface OpenAIToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: ToolDefinition['inputSchema'] };
}

function checkType(prop: JsonSchemaProperty, value: unknown): boolean {
  switch (prop.type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value) && (!prop.items || value.every((v) => checkType(prop.items!, v)));
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return false;
  }
}

const COORDINATE_KEY = /^(lat|lng|lon|latitude|longitude)$/i;

/** Light coercion for models that send "12" for 12 or "true" for true. */
function coerce(prop: JsonSchemaProperty, value: unknown): unknown {
  if ((prop.type === 'number' || prop.type === 'integer') && typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (prop.type === 'boolean' && (value === 'true' || value === 'false')) return value === 'true';
  return value;
}

/** Validate against the schema subset; returns cleaned args or an error message. */
export function validateArgs(
  tool: ToolDefinition,
  raw: unknown,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const args: Record<string, unknown> = {};
  const props = tool.inputSchema.properties;
  for (const req of tool.inputSchema.required ?? []) {
    if (input[req] === undefined || input[req] === null || input[req] === '') {
      return { ok: false, error: `missing required argument "${req}"` };
    }
  }
  for (const [key, value] of Object.entries(input)) {
    const prop = props[key];
    if (!prop) continue; // unknown keys are dropped, never forwarded
    if (value === undefined || value === null) continue;
    const v = coerce(prop, value);
    if (!checkType(prop, v)) return { ok: false, error: `argument "${key}" must be ${prop.type}` };
    if (prop.enum && !prop.enum.includes(v as string | number)) {
      return { ok: false, error: `argument "${key}" must be one of ${prop.enum.join(', ')}` };
    }
    if (typeof v === 'number') {
      const below = prop.minimum !== undefined && v < prop.minimum;
      const above = prop.maximum !== undefined && v > prop.maximum;
      if (below || above) {
        // A coordinate out of range is a wrong answer; reject it. Any other number
        // (limit, radius, zoom) is a budget — clamp it so the model need not retry.
        if (COORDINATE_KEY.test(key)) {
          return { ok: false, error: `"${key}" ${below ? `below ${prop.minimum}` : `above ${prop.maximum}`}` };
        }
        args[key] = below ? prop.minimum : prop.maximum;
        continue;
      }
    }
    args[key] = v;
  }
  return { ok: true, args };
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(
    tools: ToolDefinition[],
    private readonly ctx: ToolContext,
  ) {
    for (const t of tools) {
      if (this.tools.has(t.name)) throw new Error(`duplicate tool ${t.name}`);
      this.tools.set(t.name, t);
    }
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  toOpenAITools(): OpenAIToolSpec[] {
    return this.list().map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }

  /** Run a tool. Never throws: failures come back as `{ok:false, error}`. */
  async call(name: string, rawArgs: unknown, signal?: AbortSignal): Promise<ToolCallResult> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `unknown tool "${name}"` };
    const checked = validateArgs(tool, rawArgs);
    if (!checked.ok) return { ok: false, error: checked.error };
    try {
      const raw = await tool.execute(checked.args, this.ctx, signal);
      return { ok: true, result: boundResult(redactDeep(raw)) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg.slice(0, 300) };
    }
  }
}
