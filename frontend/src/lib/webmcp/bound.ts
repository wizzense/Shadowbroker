/**
 * Result bounding and redaction for agent tool output.
 *
 * Every tool result passes through here before it reaches a model or a foreign
 * browser agent: lists are capped, strings truncated, bulky arrays (trails,
 * geometry) dropped, and any field or URL parameter that looks like a credential
 * is removed. A tool result is model INPUT, so it must never carry a secret.
 */

export const MAX_LIST = 50;
export const DEFAULT_LIST = 15;
export const MAX_STRING = 200;
/** Hard ceiling on one serialized tool result. */
export const MAX_RESULT_CHARS = 12_000;

const SECRET_KEY = /(token|secret|passw|api[_-]?key|apikey|auth(?!or)|cookie|session|credential|signature|hmac|private[_-]?key)/i;
/** Bulky or internal fields that never help an answer. */
const DROP_KEY = /^(trail|geometry|coords?_history|_seen_at|_updated|raw|html|features|polygon|path)$/i;

/** Clamp a requested count to [1, MAX_LIST], defaulting when absent/invalid. */
export function clampLimit(value: unknown, fallback = DEFAULT_LIST): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(MAX_LIST, Math.floor(n)));
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** Remove credential-looking query parameters from a URL string; non-URLs pass through. */
export function redactUrl(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const u = new URL(value);
    let changed = false;
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_KEY.test(k) || /^(key|sig|code|access)$/i.test(k)) {
        u.searchParams.delete(k);
        changed = true;
      }
    }
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
      changed = true;
    }
    return changed ? u.toString() : value;
  } catch {
    return value;
  }
}

function trimString(s: string, max = MAX_STRING): string {
  const clean = redactUrl(s);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function roundNumber(key: string, n: number): number {
  if (!Number.isFinite(n)) return n;
  if (/^(lat|lng|lon|latitude|longitude)$/i.test(key)) return Math.round(n * 1e4) / 1e4;
  return Math.abs(n) < 1e6 && !Number.isInteger(n) ? Math.round(n * 100) / 100 : n;
}

/**
 * Flatten one entity to a bounded record: primitives only (plus short primitive
 * arrays), secrets and bulky fields removed, at most `maxFields` keys.
 */
export function trimEntity(
  item: unknown,
  opts: { maxFields?: number; maxString?: number } = {},
): Record<string, unknown> {
  const maxFields = opts.maxFields ?? 14;
  const maxString = opts.maxString ?? MAX_STRING;
  const out: Record<string, unknown> = {};
  if (!item || typeof item !== 'object') return out;
  let count = 0;
  for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
    if (count >= maxFields) break;
    if (isSecretKey(key) || DROP_KEY.test(key)) continue;
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'string') out[key] = trimString(value, maxString);
    else if (typeof value === 'number') out[key] = roundNumber(key, value);
    else if (typeof value === 'boolean') out[key] = value;
    else if (Array.isArray(value)) {
      const prims = value.filter((v) => ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 8);
      if (prims.length === 0 || prims.length !== Math.min(value.length, 8)) continue;
      out[key] = prims.map((v) => (typeof v === 'string' ? trimString(v, 80) : v));
    } else continue;
    count += 1;
  }
  return out;
}

/** Deep redaction for arbitrary JSON (backend answers): secrets out, strings trimmed, arrays capped. */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth limit]';
  if (typeof value === 'string') return trimString(value, 400);
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, MAX_LIST).map((v) => redactDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(k)) continue;
    out[k] = redactDeep(v, depth + 1);
  }
  return out;
}

/**
 * Serialize a result under MAX_RESULT_CHARS. When over budget, the largest
 * array found at the top level (or under `items`) is halved until it fits;
 * as a last resort the text is cut and marked truncated.
 */
export function boundResult(result: unknown, maxChars = MAX_RESULT_CHARS): unknown {
  let current = result;
  for (let i = 0; i < 12; i += 1) {
    const text = JSON.stringify(current) ?? 'null';
    if (text.length <= maxChars) return current;
    if (!current || typeof current !== 'object') break;
    const obj: Record<string, unknown> = Array.isArray(current)
      ? { items: current }
      : { ...(current as Record<string, unknown>) };
    const arrayKey = Object.keys(obj)
      .filter((k) => Array.isArray(obj[k]) && (obj[k] as unknown[]).length > 1)
      .sort((a, b) => JSON.stringify(obj[b]).length - JSON.stringify(obj[a]).length)[0];
    if (!arrayKey) break;
    const arr = obj[arrayKey] as unknown[];
    obj[arrayKey] = arr.slice(0, Math.max(1, Math.floor(arr.length / 2)));
    obj.truncated = true;
    current = obj;
  }
  const text = JSON.stringify(current) ?? 'null';
  return { truncated: true, text: text.slice(0, maxChars - 40) };
}
