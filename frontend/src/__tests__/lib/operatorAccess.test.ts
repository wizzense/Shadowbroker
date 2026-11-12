import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { GET as getAdminSession } from '@/app/api/admin/session/route';

async function freshModule() {
  vi.resetModules();
  return import('@/lib/operatorAccess');
}

function mockSession(body: unknown, ok = true) {
  const fetchMock = vi.fn(async () => ({ ok, json: async () => body }) as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('operator access (hosted public visitor vs operator)', () => {
  const originalLan = process.env.SHADOWBROKER_LAN_MODE;

  afterEach(() => {
    process.env.SHADOWBROKER_LAN_MODE = originalLan;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('session GET reports publicInstance from SHADOWBROKER_LAN_MODE', async () => {
    process.env.SHADOWBROKER_LAN_MODE = 'true';
    const on = await getAdminSession(new NextRequest('http://localhost:3000/api/admin/session'));
    expect(await on.json()).toMatchObject({ hasSession: false, publicInstance: true });
    process.env.SHADOWBROKER_LAN_MODE = '';
    const off = await getAdminSession(new NextRequest('http://localhost:3000/api/admin/session'));
    expect(await off.json()).toMatchObject({ publicInstance: false });
  });

  it('a public visitor without a session has no operator access and makes no operator request', async () => {
    const { hasOperatorAccess, operatorFetch } = await freshModule();
    const fetchMock = mockSession({ ok: true, hasSession: false, publicInstance: true });
    expect(await hasOperatorAccess()).toBe(false);
    expect(await operatorFetch('/api/settings/timemachine')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the session probe
  });

  it('a signed-in operator on a public instance has access', async () => {
    const { hasOperatorAccess } = await freshModule();
    mockSession({ ok: true, hasSession: true, publicInstance: true });
    expect(await hasOperatorAccess()).toBe(true);
  });

  it('a local install keeps upstream behaviour', async () => {
    const { hasOperatorAccess } = await freshModule();
    mockSession({ ok: true, hasSession: false, publicInstance: false });
    expect(await hasOperatorAccess()).toBe(true);
  });

  it('invalidate re-probes after sign-in', async () => {
    const { hasOperatorAccess, invalidateOperatorAccess } = await freshModule();
    mockSession({ ok: true, hasSession: false, publicInstance: true });
    expect(await hasOperatorAccess()).toBe(false);
    mockSession({ ok: true, hasSession: true, publicInstance: true });
    expect(await hasOperatorAccess()).toBe(false); // cached
    invalidateOperatorAccess();
    expect(await hasOperatorAccess()).toBe(true);
  });
});
