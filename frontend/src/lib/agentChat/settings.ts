/**
 * Agent chat settings. Credentials (daemon bearer, hosted API key) live in
 * sessionStorage ONLY: they die with the tab, are never written to
 * localStorage, never sent to the ShadowBroker backend, and never placed in
 * tool results. Non-secret preferences (selected backend/model) use localStorage.
 *
 * A credential may also arrive in the URL fragment
 * (`#agent-token=awdk:<token>`) so a local launcher can hand it over without a
 * paste; the fragment never reaches a server and is scrubbed on read.
 */
import type { AdapterId } from './types';

const SECRET_PREFIX = 'sb.agent.secret.';
const PREFS_KEY = 'sb.agent.prefs';

export interface AgentPrefs {
  backend: AdapterId;
  models: Partial<Record<AdapterId, string>>;
  bonsaiModel: string;
}

export const DEFAULT_PREFS: AgentPrefs = { backend: 'awdk', models: {}, bonsaiModel: 'bonsai-1.7b' };

function session(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function local(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function getSecret(id: AdapterId): string {
  return session()?.getItem(SECRET_PREFIX + id) ?? '';
}

export function setSecret(id: AdapterId, value: string): void {
  const s = session();
  if (!s) return;
  const v = value.trim();
  if (v) s.setItem(SECRET_PREFIX + id, v);
  else s.removeItem(SECRET_PREFIX + id);
}

export function loadPrefs(): AgentPrefs {
  try {
    const raw = local()?.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<AgentPrefs>;
    return { ...DEFAULT_PREFS, ...parsed, models: { ...(parsed.models ?? {}) } };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: AgentPrefs): void {
  try {
    local()?.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage full or blocked: preferences are optional */
  }
}

const FRAGMENT_KEY = /(?:^|&)agent-token=([a-z]+):([^&]+)/;

/** Move `#agent-token=<backend>:<token>` into sessionStorage and scrub it from the URL. */
export function consumeTokenFragment(loc: Location | undefined = typeof window !== 'undefined' ? window.location : undefined): AdapterId | null {
  if (!loc?.hash) return null;
  const m = FRAGMENT_KEY.exec(loc.hash.slice(1));
  if (!m) return null;
  const id = m[1] as AdapterId;
  if (!['awdk', 'awnode', 'hosted', 'gobbonet'].includes(id)) return null;
  setSecret(id, decodeURIComponent(m[2]));
  try {
    const rest = loc.hash.slice(1).replace(FRAGMENT_KEY, '').replace(/^&/, '');
    window.history.replaceState(null, '', `${loc.pathname}${loc.search}${rest ? `#${rest}` : ''}`);
  } catch {
    /* non-browser */
  }
  return id;
}
