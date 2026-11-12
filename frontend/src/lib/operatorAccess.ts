import { API_BASE } from '@/lib/api';

/**
 * Can this browser use the operator surface (API keys, Time Machine
 * settings, agent action queue, Shodan connector)?
 *
 * On a hosted/LAN deployment (frontend runs with SHADOWBROKER_LAN_MODE) the
 * proxy only forwards the operator key for a signed-in admin session, so an
 * anonymous visitor gets 403 on every operator route. Those visitors should
 * see the public map with no operator setup modals and no operator polling.
 *
 * Local single-user installs (no LAN mode) keep upstream behaviour: the proxy
 * already authenticates them, so this returns true.
 *
 * Fails OPEN to upstream behaviour (true) only when the session endpoint is
 * unreachable (e.g. native shells that have no Next.js route); the backend
 * still enforces auth on every operator route either way.
 */
let _cached: Promise<boolean> | null = null;

export function hasOperatorAccess(): Promise<boolean> {
  if (_cached) return _cached;
  _cached = (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/admin/session`, { cache: 'no-store' });
      if (!res.ok) return true;
      const data = await res.json().catch(() => ({}));
      if (data && data.publicInstance === true) return Boolean(data.hasSession);
      return true;
    } catch {
      return true;
    }
  })();
  return _cached;
}

/** Call after an admin session is minted or cleared. */
export function invalidateOperatorAccess(): void {
  _cached = null;
}

/** fetch() for an operator-only GET; resolves null (no request made) for a public visitor. */
export async function operatorFetch(input: string, init?: RequestInit): Promise<Response | null> {
  if (!(await hasOperatorAccess())) return null;
  return fetch(input, init);
}
