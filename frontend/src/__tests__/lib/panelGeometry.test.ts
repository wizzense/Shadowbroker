import { describe, expect, it } from 'vitest';
import {
  FREE_AREA_MARGINS,
  cascadeRects,
  computeFreeArea,
  createDefaultLayout,
  definePanel,
  maximizePanel,
  placeNewFloat,
  resolvePanelState,
  restorePanel,
  sanitizeLayout,
  snapMove,
  snapResize,
  tileRects,
  type Rect,
} from '@/lib/panelLayout';

// The owner's screen: 1980x1580, left dock 24..344, right dock 1564..1948.
const vp = { width: 1980, height: 1580 };
const leftDock: Rect = { x: 32, y: 96, w: 304, h: 1448 };
const rightDock: Rect = { x: 1564, y: 96, w: 384, h: 1448 };

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('computeFreeArea', () => {
  it('is the strip between the open docks, below the header', () => {
    const free = computeFreeArea(vp, [leftDock, rightDock]);
    expect(free.x).toBe(336 + FREE_AREA_MARGINS.gap);
    expect(free.x + free.w).toBe(1564 - FREE_AREA_MARGINS.gap);
    expect(free.y).toBe(FREE_AREA_MARGINS.top);
    expect(overlaps(free, leftDock)).toBe(false);
    expect(overlaps(free, rightDock)).toBe(false);
  });

  it('ignores a dock slid off-screen', () => {
    const hiddenLeft = { ...leftDock, x: -400 };
    expect(computeFreeArea(vp, [hiddenLeft, rightDock]).x).toBe(FREE_AREA_MARGINS.gap);
  });

  it('falls back to the whole viewport when the strip is too narrow', () => {
    const narrow = { width: 700, height: 800 };
    const free = computeFreeArea(narrow, [{ x: 0, y: 0, w: 320, h: 800 }, { x: 380, y: 0, w: 320, h: 800 }]);
    expect(free.x).toBe(FREE_AREA_MARGINS.gap);
    expect(free.w).toBe(700 - 2 * FREE_AREA_MARGINS.gap);
  });
});

describe('placeNewFloat — cascade placement that avoids the docks', () => {
  const free = computeFreeArea(vp, [leftDock, rightDock]);

  it('a newly floated panel never covers a docked column', () => {
    const r = placeNewFloat({ w: 304, h: 600 }, free, []);
    expect(overlaps(r, leftDock)).toBe(false);
    expect(overlaps(r, rightDock)).toBe(false);
    expect(r).toMatchObject({ x: free.x, y: free.y, w: 304, h: 600 });
  });

  it('successive floats go side by side into free space, overlapping nothing', () => {
    const a = placeNewFloat({ w: 304, h: 600 }, free, []);
    const b = placeNewFloat({ w: 304, h: 600 }, free, [a]);
    const c = placeNewFloat({ w: 304, h: 600 }, free, [a, b]);
    expect(b).toMatchObject({ x: a.x + a.w + 8, y: a.y });
    const all = [a, b, c];
    for (let i = 0; i < all.length; i++) {
      expect(overlaps(all[i], leftDock) || overlaps(all[i], rightDock)).toBe(false);
      for (let j = i + 1; j < all.length; j++) expect(overlaps(all[i], all[j])).toBe(false);
    }
  });

  it('when the free area is full, floats cascade instead of stacking exactly', () => {
    const small = { x: 400, y: 100, w: 500, h: 500 };
    const a = placeNewFloat({ w: 400, h: 400 }, small, []);
    const b = placeNewFloat({ w: 400, h: 400 }, small, [a]);
    const c = placeNewFloat({ w: 400, h: 400 }, small, [a, b]);
    expect([b.x - a.x, b.y - a.y]).toEqual([32, 32]);
    expect([c.x - b.x, c.y - b.y]).toEqual([32, 32]);
  });

  it('a panel taller than the free area is fitted into it', () => {
    const r = placeNewFloat({ w: 2000, h: 5000 }, free, []);
    expect(r.w).toBe(free.w);
    expect(r.h).toBe(free.h);
  });
});

describe('tile / cascade', () => {
  const free = { x: 352, y: 96, w: 1196, h: 1436 };

  it('tile fills the free area without overlaps', () => {
    const rects = tileRects(4, free);
    expect(rects).toHaveLength(4);
    for (let i = 0; i < rects.length; i++) {
      expect(rects[i].x).toBeGreaterThanOrEqual(free.x);
      expect(rects[i].x + rects[i].w).toBeLessThanOrEqual(free.x + free.w + 1);
      expect(rects[i].y + rects[i].h).toBeLessThanOrEqual(free.y + free.h + 1);
      for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i], rects[j])).toBe(false);
    }
  });

  it('cascade offsets each panel diagonally and keeps sizes', () => {
    const rects = cascadeRects([{ w: 400, h: 500 }, { w: 300, h: 300 }, { w: 380, h: 600 }], free);
    expect(rects.map((r) => [r.x - free.x, r.y - free.y])).toEqual([
      [0, 0],
      [32, 32],
      [64, 64],
    ]);
    expect(rects[1]).toMatchObject({ w: 300, h: 300 });
  });
});

describe('snap', () => {
  it('snaps to viewport edges within 12px, not beyond', () => {
    expect(snapMove({ x: 9, y: 500, w: 300, h: 300 }, vp, [])).toMatchObject({ x: 0 });
    expect(snapMove({ x: 13, y: 500, w: 300, h: 300 }, vp, [])).toMatchObject({ x: 13 });
    expect(snapMove({ x: 500, y: 1580 - 300 - 7, w: 300, h: 300 }, vp, [])).toMatchObject({ y: 1280 });
  });

  it('snaps beside another panel and aligns its top', () => {
    const other = { x: 400, y: 200, w: 300, h: 400 };
    const r = snapMove({ x: 708, y: 195, w: 300, h: 300 }, vp, [other]);
    expect(r).toMatchObject({ x: 700, y: 200 });
  });

  it('does not snap to a panel that is far away on the other axis', () => {
    const other = { x: 400, y: 200, w: 300, h: 100 };
    expect(snapMove({ x: 708, y: 900, w: 300, h: 300 }, vp, [other]).x).toBe(708);
  });

  it('resize snaps only the moving edge', () => {
    const other = { x: 900, y: 100, w: 300, h: 600 };
    const r = snapResize({ x: 500, y: 150, w: 392, h: 300 }, 'e', vp, [other]);
    expect(r).toEqual({ x: 500, y: 150, w: 400, h: 300 });
    const s = snapResize({ x: 500, y: 150, w: 392, h: 300 }, 's', vp, [other]);
    expect(s.w).toBe(392);
  });
});

describe('maximize / restore', () => {
  const def = definePanel({ id: 'civic', title: 'CIVIC', defaultDock: 'left' });
  const free = { x: 352, y: 96, w: 1196, h: 1436 };

  it('round-trips a floating panel back to its exact rect', () => {
    const before: Rect = { x: 600, y: 300, w: 420, h: 500 };
    let l = createDefaultLayout();
    l.panels.civic = { mode: 'floating', rect: before, autoHeight: true };
    l = maximizePanel(l, 'civic', free, before, false);
    expect(resolvePanelState(l, def)).toMatchObject({ maximized: true, rect: free, autoHeight: false });
    l = restorePanel(l, def);
    expect(resolvePanelState(l, def)).toMatchObject({ maximized: false, rect: before, mode: 'floating' });
  });

  it('a docked panel maximizes into free space and restores into its dock', () => {
    let l = maximizePanel(createDefaultLayout(), 'civic', free, { x: 32, y: 600, w: 304, h: 63 }, true);
    expect(resolvePanelState(l, def).mode).toBe('floating');
    l = restorePanel(l, def);
    expect(resolvePanelState(l, def)).toMatchObject({ mode: 'docked', dock: 'left', maximized: false });
  });

  it('maximized state survives persistence', () => {
    const l = maximizePanel(createDefaultLayout(), 'civic', free, { x: 1, y: 2, w: 300, h: 300 }, false);
    const restored = sanitizeLayout(JSON.parse(JSON.stringify(l)));
    expect(resolvePanelState(restored, def)).toMatchObject({ maximized: true, restoreRect: { x: 1, y: 2, w: 300, h: 300 } });
  });
});
