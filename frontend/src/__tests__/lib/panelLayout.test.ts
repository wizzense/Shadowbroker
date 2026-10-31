import { describe, expect, it } from 'vitest';
import {
  PANEL_LAYOUT_STORAGE_KEY,
  bringToFront,
  buildPreset,
  clampDockWidth,
  clampRect,
  clearPanelLayout,
  createDefaultLayout,
  definePanel,
  dockPanel,
  floatPanel,
  loadPanelLayout,
  patchPanel,
  resizeRect,
  resolvePanelState,
  sanitizeLayout,
  savePanelLayout,
  MIN_DOCK_WIDTH,
} from '@/lib/panelLayout';

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(seed));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    key: (i) => Array.from(data.keys())[i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

function throwingStorage(): Storage {
  const boom = () => {
    throw new Error('quota / private mode');
  };
  return { length: 0, clear: boom, getItem: boom, key: boom, removeItem: boom, setItem: boom };
}

const vp = { width: 1200, height: 800 };
const layers = definePanel({ id: 'layers', title: 'DATA LAYERS', defaultDock: 'left', order: 0, role: 'primary' });
const feed = definePanel({ id: 'feed', title: 'FEED', defaultDock: 'right', order: 30, role: 'primary' });
const recon = definePanel({ id: 'recon', title: 'RECON', defaultDock: 'left', order: 30 });
const floater = definePanel({
  id: 'agent',
  title: 'AGENT',
  defaultDock: null,
  defaultRect: () => ({ x: 100, y: 100, w: 400, h: 300 }),
});

describe('panelLayout — resolve defaults', () => {
  it('unknown panels resolve to their definition defaults', () => {
    const s = resolvePanelState(createDefaultLayout(), recon);
    expect(s).toMatchObject({ mode: 'docked', dock: 'left', minimized: false, closed: false, rect: null });
  });

  it('defaultDock null starts floating', () => {
    expect(resolvePanelState(createDefaultLayout(), floater).mode).toBe('floating');
  });
});

describe('panelLayout — clamp', () => {
  it('keeps a rect fully inside the viewport', () => {
    expect(clampRect({ x: 1100, y: -50, w: 400, h: 300 }, vp)).toEqual({ x: 800, y: 0, w: 400, h: 300 });
    expect(clampRect({ x: -20, y: 790, w: 300, h: 300 }, vp)).toEqual({ x: 0, y: 500, w: 300, h: 300 });
  });

  it('enforces min size and caps size at the viewport', () => {
    expect(clampRect({ x: 0, y: 0, w: 10, h: 10 }, vp, { minWidth: 240, minHeight: 120 })).toEqual({
      x: 0,
      y: 0,
      w: 240,
      h: 120,
    });
    expect(clampRect({ x: 50, y: 50, w: 5000, h: 5000 }, vp)).toEqual({ x: 0, y: 0, w: 1200, h: 800 });
  });

  it('resize from the west edge keeps the east edge fixed and respects minWidth', () => {
    const start = { x: 300, y: 100, w: 400, h: 300 };
    expect(resizeRect(start, 'w', -100, 0, vp)).toEqual({ x: 200, y: 100, w: 500, h: 300 });
    const tooSmall = resizeRect(start, 'w', 1000, 0, vp, { minWidth: 240 });
    expect(tooSmall.w).toBe(240);
    expect(tooSmall.x + tooSmall.w).toBe(700);
  });

  it('resize to full height stops at the viewport', () => {
    const r = resizeRect({ x: 24, y: 96, w: 320, h: 400 }, 'se', 0, 2000, vp);
    expect(r.y + r.h).toBe(800);
    const full = resizeRect(r, 'n', 0, -2000, vp);
    expect(full).toMatchObject({ y: 0, h: 800 });
  });

  it('dock widths are clamped', () => {
    expect(clampDockWidth(10)).toBe(MIN_DOCK_WIDTH);
    expect(clampDockWidth(5000, vp)).toBeLessThanOrEqual(vp.width - 80);
  });
});

describe('panelLayout — z-order, float, dock back', () => {
  it('bringToFront puts a panel on top and keeps z dense', () => {
    let l = createDefaultLayout();
    l = floatPanel(l, 'a', { x: 0, y: 0, w: 300, h: 200 });
    l = floatPanel(l, 'b', { x: 0, y: 0, w: 300, h: 200 });
    l = floatPanel(l, 'c', { x: 0, y: 0, w: 300, h: 200 });
    expect([l.panels.a.z, l.panels.b.z, l.panels.c.z]).toEqual([1, 2, 3]);
    l = bringToFront(l, 'a');
    expect([l.panels.b.z, l.panels.c.z, l.panels.a.z]).toEqual([1, 2, 3]);
    // already on top → same object, no churn
    expect(bringToFront(l, 'a')).toBe(l);
  });

  it('dockPanel returns a floating panel to its default slot', () => {
    let l = floatPanel(createDefaultLayout(), 'layers', { x: 400, y: 50, w: 300, h: 600 });
    l = patchPanel(l, 'layers', { minimized: true, dockHeight: 200 });
    l = dockPanel(l, layers);
    expect(resolvePanelState(l, layers)).toMatchObject({
      mode: 'docked',
      dock: 'left',
      minimized: false,
      dockHeight: null,
      closed: false,
    });
  });
});

describe('panelLayout — persistence', () => {
  it('save → load round-trips and drops poppedOut', () => {
    const storage = memoryStorage();
    let l = floatPanel(createDefaultLayout(), 'feed', { x: 10, y: 20, w: 500, h: 400 });
    l = patchPanel(l, 'feed', { poppedOut: true, minimized: true });
    l = patchPanel(l, 'recon', { closed: true });
    l = { ...l, docks: { ...l.docks, left: { width: 420 } } };
    expect(savePanelLayout(l, storage)).toBe(true);
    const restored = loadPanelLayout(storage);
    expect(restored.panels.feed).toMatchObject({ mode: 'floating', rect: { x: 10, y: 20, w: 500, h: 400 }, minimized: true });
    expect(restored.panels.feed.poppedOut).toBeUndefined();
    expect(restored.panels.recon.closed).toBe(true);
    expect(restored.docks.left.width).toBe(420);
  });

  it('corrupt or foreign JSON falls back to defaults', () => {
    expect(loadPanelLayout(memoryStorage({ [PANEL_LAYOUT_STORAGE_KEY]: '{not json' }))).toEqual(createDefaultLayout());
    expect(loadPanelLayout(memoryStorage({ [PANEL_LAYOUT_STORAGE_KEY]: '{"version":9}' }))).toEqual(createDefaultLayout());
    const junk = sanitizeLayout({
      version: 1,
      panels: { x: { mode: 'sideways', rect: { x: 'a' }, z: -3, minimized: 'yes' }, y: null },
      docks: { left: { width: 'wide' } },
    });
    expect(junk.panels.x).toEqual({});
    expect(junk.panels.y).toBeUndefined();
    expect(junk.docks.left.width).toBe(320);
  });

  it('storage that throws never throws to the caller', () => {
    const s = throwingStorage();
    expect(loadPanelLayout(s)).toEqual(createDefaultLayout());
    expect(savePanelLayout(createDefaultLayout(), s)).toBe(false);
    expect(() => clearPanelLayout(s)).not.toThrow();
    expect(loadPanelLayout(null)).toEqual(createDefaultLayout());
  });

  it('reset clears the stored layout', () => {
    const storage = memoryStorage();
    savePanelLayout(patchPanel(createDefaultLayout(), 'recon', { closed: true }), storage);
    clearPanelLayout(storage);
    expect(storage.getItem(PANEL_LAYOUT_STORAGE_KEY)).toBeNull();
    expect(loadPanelLayout(storage)).toEqual(createDefaultLayout());
  });
});

describe('panelLayout — presets', () => {
  const defs = [layers, feed, recon];

  it('default preset equals a fresh layout', () => {
    expect(buildPreset('default', defs, vp)).toEqual(createDefaultLayout());
  });

  it('map focus collapses every panel', () => {
    const l = buildPreset('map-focus', defs, vp);
    for (const d of defs) expect(resolvePanelState(l, d).minimized).toBe(true);
  });

  it('analyst wide keeps primaries open, collapses tools, widens docks', () => {
    const l = buildPreset('analyst-wide', defs, vp);
    expect(resolvePanelState(l, layers).minimized).toBe(false);
    expect(resolvePanelState(l, feed).minimized).toBe(false);
    expect(resolvePanelState(l, recon).minimized).toBe(true);
    expect(l.docks.left.width).toBeGreaterThan(320);
  });
});
