import React, { useEffect } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FloatingPanel, PanelDock, PanelFloatLayer, PanelsMenu, PanelWorkspaceProvider } from '@/components/panels';
import { PANEL_LAYOUT_STORAGE_KEY } from '@/lib/panelLayout';

const mounts = vi.fn();

// Node 22+ ships a global localStorage that shadows jsdom's and is unusable
// without --localstorage-file; give the workspace a real in-memory one.
function installMemoryStorage(): Storage {
  const data = new Map<string, string>();
  const mem: Storage = {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    key: (i) => Array.from(data.keys())[i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
  vi.stubGlobal('localStorage', mem);
  Object.defineProperty(window, 'localStorage', { value: mem, configurable: true });
  return mem;
}
let storage: Storage;

function Probe() {
  useEffect(() => {
    mounts();
  }, []);
  return <div data-testid="probe">probe body</div>;
}

function Harness() {
  return (
    <PanelWorkspaceProvider>
      <PanelFloatLayer />
      <PanelsMenu />
      <PanelDock side="left" open />
      <PanelDock side="right" open />
      <FloatingPanel id="probe" title="PROBE PANEL" defaultDock="left" order={5}>
        <Probe />
      </FloatingPanel>
    </PanelWorkspaceProvider>
  );
}

describe('FloatingPanel workspace', () => {
  beforeEach(() => {
    storage = installMemoryStorage();
    mounts.mockClear();
  });

  it('docks into its column, closes, and reopens from the PANELS menu', async () => {
    render(<Harness />);
    const body = await screen.findByTestId('probe');
    expect(body.closest('[data-panel-dock="left"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /close panel/i }));
    expect(screen.queryByTestId('probe')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /panels/i }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /probe panel/i }));
    expect(await screen.findByTestId('probe')).toBeTruthy();
  });

  it('undocking moves the body to the float layer without remounting it, and persists', async () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      await act(async () => {});
      expect(mounts).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: /undock/i }));
      const body = screen.getByTestId('probe');
      expect(body.closest('[data-panel-float-layer]')).not.toBeNull();
      expect(mounts).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      const saved = JSON.parse(storage.getItem(PANEL_LAYOUT_STORAGE_KEY) ?? '{}');
      expect(saved.panels.probe.mode).toBe('floating');

      fireEvent.click(screen.getByRole('button', { name: /dock back/i }));
      expect(screen.getByTestId('probe').closest('[data-panel-dock="left"]')).not.toBeNull();
      expect(mounts).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('collapse hides the body but keeps it mounted', async () => {
    render(<Harness />);
    await screen.findByTestId('probe');
    fireEvent.click(screen.getByRole('button', { name: /collapse panel/i }));
    expect(mounts).toHaveBeenCalledTimes(1);
    const hiddenSlot = screen.getByTestId('probe').closest('[data-panel-body]')?.parentElement as HTMLElement;
    expect(hiddenSlot.style.display).toBe('none');
    fireEvent.click(screen.getByRole('button', { name: /expand panel/i }));
    const slot = screen.getByTestId('probe').closest('[data-panel-body]')?.parentElement as HTMLElement;
    expect(slot.style.display).not.toBe('none');
    expect(mounts).toHaveBeenCalledTimes(1);
  });
});
