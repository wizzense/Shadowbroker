/**
 * Panel workspace layout — pure state + persistence for the movable,
 * resizable, dockable HUD panels (see components/panels/).
 *
 * Every function here is pure (no React, no DOM) except the storage helpers,
 * which take an injectable Storage and never throw.
 *
 * Model
 * -----
 * - A panel is either DOCKED into a side column (left/right) or FLOATING at
 *   an absolute rect inside the viewport. Popped-out panels live in their own
 *   browser window; that flag is never persisted (a reload cannot reopen a
 *   window without a user gesture).
 * - The layout only stores what differs per panel; a panel with no entry
 *   resolves to its definition's defaults, so panels added later by other
 *   features appear in their default slot without a migration.
 */

export type DockSide = 'left' | 'right';
export type PanelMode = 'docked' | 'floating';
/** Coarse role used by presets: primary panels stay open, tools collapse. */
export type PanelRole = 'primary' | 'tool';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface PanelDefinition {
  id: string;
  title: string;
  /** Dock the panel starts in; null = starts floating at defaultRect. */
  defaultDock: DockSide | null;
  /** Sort key inside a dock column (ascending, top to bottom). */
  order: number;
  /** Where the panel floats when undocked without a remembered rect. */
  defaultRect: (vp: Viewport) => Rect;
  minWidth: number;
  minHeight: number;
  role: PanelRole;
}

export interface PanelState {
  mode: PanelMode;
  dock: DockSide;
  /** Floating rect; null = use the definition's defaultRect. */
  rect: Rect | null;
  /** Fixed height while docked; null = natural (or grow) height. */
  dockHeight: number | null;
  minimized: boolean;
  closed: boolean;
  poppedOut: boolean;
  /** Stacking order among floating panels; higher = in front. */
  z: number;
  /** Floating height follows content (capped) until the user resizes it. */
  autoHeight: boolean;
  /** Filling the free map area; restoreRect (or the dock) is where it returns. */
  maximized: boolean;
  /** Rect to restore on un-maximize; null + maximized = return to the dock. */
  restoreRect: Rect | null;
}

export interface DockState {
  width: number;
}

export interface PanelLayout {
  version: 1;
  panels: Record<string, Partial<PanelState>>;
  docks: Record<DockSide, DockState>;
}

export const PANEL_LAYOUT_STORAGE_KEY = 'sb_panel_layout_v1';
export const DEFAULT_DOCK_WIDTHS: Record<DockSide, number> = { left: 320, right: 400 };
export const MIN_DOCK_WIDTH = 260;
export const MAX_DOCK_WIDTH = 900;
export const DEFAULT_MIN_WIDTH = 240;
export const DEFAULT_MIN_HEIGHT = 120;
/** Height of the panel title bar (px). */
export const HEADER_HEIGHT = 22;
/** Snap distance for edges (viewport and other panels). */
export const SNAP_THRESHOLD = 12;
/** First-float auto height never exceeds this fraction of the viewport. */
export const MAX_AUTO_HEIGHT_FRACTION = 0.85;
/** Offset between cascaded floats. */
export const CASCADE_STEP = 32;
/** Space kept clear of the brand header (top) and the ticker/coords bar (bottom). */
export const FREE_AREA_MARGINS = { top: 96, bottom: 48, gap: 16 };

export function createDefaultLayout(): PanelLayout {
  return {
    version: 1,
    panels: {},
    docks: {
      left: { width: DEFAULT_DOCK_WIDTHS.left },
      right: { width: DEFAULT_DOCK_WIDTHS.right },
    },
  };
}

/** Build a full definition from the partial props a panel declares. */
export function definePanel(
  def: Pick<PanelDefinition, 'id' | 'title'> & Partial<Omit<PanelDefinition, 'id' | 'title'>>,
): PanelDefinition {
  const defaultDock = def.defaultDock === undefined ? 'left' : def.defaultDock;
  return {
    id: def.id,
    title: def.title,
    defaultDock,
    order: def.order ?? 100,
    minWidth: def.minWidth ?? DEFAULT_MIN_WIDTH,
    minHeight: def.minHeight ?? DEFAULT_MIN_HEIGHT,
    role: def.role ?? 'tool',
    defaultRect:
      def.defaultRect ??
      ((vp: Viewport) => {
        const w = Math.min(380, vp.width - 48);
        const h = Math.min(480, vp.height - 160);
        return { x: Math.round((vp.width - w) / 2), y: 120, w, h };
      }),
  };
}

function clampNum(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.min(Math.max(v, lo), hi);
}

/**
 * Constrain a rect to the viewport: size between the minimums and the
 * viewport, position so the whole panel stays visible.
 */
export function clampRect(
  rect: Rect,
  vp: Viewport,
  min: { minWidth?: number; minHeight?: number } = {},
): Rect {
  const minW = Math.min(min.minWidth ?? DEFAULT_MIN_WIDTH, vp.width);
  const minH = Math.min(min.minHeight ?? DEFAULT_MIN_HEIGHT, vp.height);
  const w = Math.round(clampNum(rect.w, minW, vp.width));
  const h = Math.round(clampNum(rect.h, minH, vp.height));
  const x = Math.round(clampNum(rect.x, 0, vp.width - w));
  const y = Math.round(clampNum(rect.y, 0, vp.height - h));
  return { x, y, w, h };
}

/** Resize handle direction: any combination of n/s/e/w. */
export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * Apply a resize drag of (dx, dy) on the given edge(s). The opposite edge
 * stays put; the result respects the minimums and the viewport.
 */
export function resizeRect(
  start: Rect,
  dir: ResizeDir,
  dx: number,
  dy: number,
  vp: Viewport,
  min: { minWidth?: number; minHeight?: number } = {},
): Rect {
  const minW = Math.min(min.minWidth ?? DEFAULT_MIN_WIDTH, vp.width);
  const minH = Math.min(min.minHeight ?? DEFAULT_MIN_HEIGHT, vp.height);
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  if (dir.includes('e')) right = clampNum(right + dx, left + minW, vp.width);
  if (dir.includes('w')) left = clampNum(left + dx, 0, right - minW);
  if (dir.includes('s')) bottom = clampNum(bottom + dy, top + minH, vp.height);
  if (dir.includes('n')) top = clampNum(top + dy, 0, bottom - minH);
  return clampRect({ x: left, y: top, w: right - left, h: bottom - top }, vp, min);
}

export function clampDockWidth(width: number, vp?: Viewport): number {
  const hi = vp ? Math.min(MAX_DOCK_WIDTH, Math.max(MIN_DOCK_WIDTH, vp.width - 80)) : MAX_DOCK_WIDTH;
  return Math.round(clampNum(width, MIN_DOCK_WIDTH, hi));
}

/** Merge the stored entry over the definition's defaults. */
export function resolvePanelState(layout: PanelLayout, def: PanelDefinition): PanelState {
  const stored = layout.panels[def.id] ?? {};
  return {
    mode: stored.mode ?? (def.defaultDock === null ? 'floating' : 'docked'),
    dock: stored.dock ?? def.defaultDock ?? 'left',
    rect: stored.rect ?? null,
    dockHeight: stored.dockHeight ?? null,
    minimized: stored.minimized ?? false,
    closed: stored.closed ?? false,
    poppedOut: stored.poppedOut ?? false,
    z: stored.z ?? 0,
    autoHeight: stored.autoHeight ?? false,
    maximized: stored.maximized ?? false,
    restoreRect: stored.restoreRect ?? null,
  };
}

export function patchPanel(layout: PanelLayout, id: string, patch: Partial<PanelState>): PanelLayout {
  return {
    ...layout,
    panels: { ...layout.panels, [id]: { ...layout.panels[id], ...patch } },
  };
}

export function topZ(layout: PanelLayout): number {
  let max = 0;
  for (const p of Object.values(layout.panels)) {
    if (typeof p.z === 'number' && p.z > max) max = p.z;
  }
  return max;
}

/** Raise a panel above every other; renumbers z densely to keep values small. */
export function bringToFront(layout: PanelLayout, id: string): PanelLayout {
  const current = layout.panels[id]?.z ?? 0;
  const max = topZ(layout);
  if (current > 0 && current === max) {
    const ties = Object.values(layout.panels).filter((p) => p.z === max).length;
    if (ties === 1) return layout;
  }
  const ordered = Object.entries(layout.panels)
    .filter(([pid, p]) => pid !== id && typeof p.z === 'number' && p.z > 0)
    .sort((a, b) => (a[1].z ?? 0) - (b[1].z ?? 0));
  const panels: PanelLayout['panels'] = { ...layout.panels };
  ordered.forEach(([pid], i) => {
    panels[pid] = { ...panels[pid], z: i + 1 };
  });
  panels[id] = { ...panels[id], z: ordered.length + 1 };
  return { ...layout, panels };
}

/** Return a panel to its default dock slot (or default float rect). */
export function dockPanel(layout: PanelLayout, def: PanelDefinition): PanelLayout {
  return patchPanel(layout, def.id, {
    mode: def.defaultDock === null ? 'floating' : 'docked',
    dock: def.defaultDock ?? 'left',
    rect: def.defaultDock === null ? null : layout.panels[def.id]?.rect ?? null,
    dockHeight: null,
    minimized: false,
    closed: false,
    poppedOut: false,
    maximized: false,
    restoreRect: null,
  });
}

export function floatPanel(layout: PanelLayout, id: string, rect: Rect): PanelLayout {
  return bringToFront(patchPanel(layout, id, { mode: 'floating', rect }), id);
}

export function setDockWidth(layout: PanelLayout, side: DockSide, width: number, vp?: Viewport): PanelLayout {
  return { ...layout, docks: { ...layout.docks, [side]: { width: clampDockWidth(width, vp) } } };
}

// ── Free-area placement, cascade, tile ────────────────────────────────────

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * The part of the viewport not covered by the dock columns (obstacles) and
 * the header/footer bands: where new floats go so they never hide a docked
 * panel. Obstacles left of centre push the left bound, others the right
 * bound; off-screen obstacles (a slid-away dock) are ignored. Falls back to
 * the whole viewport (minus margins) when the strip is narrower than minWidth.
 */
export function computeFreeArea(vp: Viewport, obstacles: Rect[], minWidth = DEFAULT_MIN_WIDTH): Rect {
  const { top, bottom, gap } = FREE_AREA_MARGINS;
  const screen: Rect = { x: 0, y: 0, w: vp.width, h: vp.height };
  let left = gap;
  let right = vp.width - gap;
  for (const o of obstacles) {
    if (o.w <= 0 || o.h <= 0 || !intersects(o, screen)) continue;
    const cx = o.x + o.w / 2;
    if (cx < vp.width / 2) left = Math.max(left, o.x + o.w + gap);
    else right = Math.min(right, o.x - gap);
  }
  const y = Math.min(top, Math.max(0, vp.height - DEFAULT_MIN_HEIGHT));
  const h = Math.max(DEFAULT_MIN_HEIGHT, vp.height - y - bottom);
  if (right - left < Math.min(minWidth, vp.width - 2 * gap)) {
    return { x: gap, y, w: Math.max(0, vp.width - 2 * gap), h };
  }
  return { x: Math.round(left), y, w: Math.round(right - left), h };
}

/** Fit a size inside an area: never larger than the area, never below the minimums. */
function fitSize(size: { w: number; h: number }, area: Rect, min: { minWidth?: number; minHeight?: number }) {
  return {
    w: Math.round(Math.max(Math.min(size.w, area.w), Math.min(min.minWidth ?? DEFAULT_MIN_WIDTH, area.w))),
    h: Math.round(Math.max(Math.min(size.h, area.h), Math.min(min.minHeight ?? DEFAULT_MIN_HEIGHT, area.h))),
  };
}

function cascadeSlots(free: Rect, w: number, h: number, step: number): number {
  return Math.max(1, Math.floor(Math.min(free.w - w, free.h - h) / step) + 1);
}

/** True when `r` covers any part of any obstacle. */
export function overlapsAny(r: Rect, obstacles: Rect[]): boolean {
  return obstacles.some((o) => intersects(r, o));
}

/**
 * Where a newly floated panel goes, inside the free area (never over a dock):
 * 1. the top-most, then left-most spot that overlaps NO existing float
 *    (candidates: the free area's corner, right of / below each float);
 * 2. otherwise the first cascade slot whose top-left is not already taken,
 *    so repeated undocks fan out instead of stacking exactly.
 */
export function placeNewFloat(
  size: { w: number; h: number },
  free: Rect,
  existing: Rect[],
  min: { minWidth?: number; minHeight?: number } = {},
  step = CASCADE_STEP,
): Rect {
  const { w, h } = fitSize(size, free, min);
  const gap = 8;
  const xs = [free.x, ...existing.map((o) => o.x + o.w + gap)];
  const ys = [free.y, ...existing.map((o) => o.y + o.h + gap)];
  const candidates: Rect[] = [];
  for (const y of ys) {
    for (const x of xs) {
      const r = { x, y, w, h };
      if (x < free.x || y < free.y || x + w > free.x + free.w || y + h > free.y + free.h) continue;
      if (!overlapsAny(r, existing)) candidates.push(r);
    }
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => a.y - b.y || a.x - b.x);
    return candidates[0];
  }
  const slots = cascadeSlots(free, w, h, step);
  const taken = (x: number, y: number) =>
    existing.some((r) => Math.abs(r.x - x) < step / 2 && Math.abs(r.y - y) < step / 2);
  for (let k = 0; k < slots; k++) {
    const x = free.x + k * step;
    const y = free.y + k * step;
    if (!taken(x, y)) return { x, y, w, h };
  }
  return { x: free.x, y: free.y, w, h };
}

/** Cascade: each float keeps its (fitted) size, offset diagonally from the free area's corner. */
export function cascadeRects(sizes: { w: number; h: number }[], free: Rect, step = CASCADE_STEP): Rect[] {
  return sizes.map((size, i) => {
    const { w, h } = fitSize(size, free, {});
    const k = i % cascadeSlots(free, w, h, step);
    return { x: free.x + k * step, y: free.y + k * step, w, h };
  });
}

/** Tile: an even grid over the free area (column count follows its aspect), with a gap. */
export function tileRects(count: number, free: Rect, gap = 8): Rect[] {
  if (count <= 0) return [];
  const aspect = free.w / Math.max(free.h, 1);
  const cols = Math.max(1, Math.min(count, Math.round(Math.sqrt(count * aspect)) || 1));
  const rows = Math.ceil(count / cols);
  const cw = (free.w - gap * (cols - 1)) / cols;
  const rh = (free.h - gap * (rows - 1)) / rows;
  const out: Rect[] = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    out.push({
      x: Math.round(free.x + col * (cw + gap)),
      y: Math.round(free.y + row * (rh + gap)),
      w: Math.round(cw),
      h: Math.round(rh),
    });
  }
  return out;
}

// ── Snapping ───────────────────────────────────────────────────────────────

function nearest(value: number, targets: number[], threshold: number): number {
  let best = value;
  let bestD = Infinity;
  for (const t of targets) {
    const d = Math.abs(t - value);
    if (d <= threshold && d < bestD) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

function rangesNear(a0: number, a1: number, b0: number, b1: number, t: number): boolean {
  return a0 <= b1 + t && b0 <= a1 + t;
}

/**
 * Snap a moving rect to the viewport edges and to other panels' edges within
 * `threshold` px. Panels only attract along an axis when they are beside each
 * other on the other axis (no long-distance alignment jumps).
 */
export function snapMove(rect: Rect, vp: Viewport, others: Rect[], threshold = SNAP_THRESHOLD): Rect {
  const xs: number[] = [0, vp.width - rect.w];
  const ys: number[] = [0, vp.height - rect.h];
  for (const o of others) {
    if (rangesNear(rect.y, rect.y + rect.h, o.y, o.y + o.h, threshold)) {
      xs.push(o.x + o.w, o.x - rect.w, o.x, o.x + o.w - rect.w);
    }
    if (rangesNear(rect.x, rect.x + rect.w, o.x, o.x + o.w, threshold)) {
      ys.push(o.y + o.h, o.y - rect.h, o.y, o.y + o.h - rect.h);
    }
  }
  return { ...rect, x: nearest(rect.x, xs, threshold), y: nearest(rect.y, ys, threshold) };
}

/** Snap only the edges a resize is moving; never produces a rect below the minimums. */
export function snapResize(
  rect: Rect,
  dir: ResizeDir,
  vp: Viewport,
  others: Rect[],
  min: { minWidth?: number; minHeight?: number } = {},
  threshold = SNAP_THRESHOLD,
): Rect {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.w;
  let bottom = rect.y + rect.h;
  const xEdges = [0, vp.width];
  const yEdges = [0, vp.height];
  for (const o of others) {
    if (rangesNear(top, bottom, o.y, o.y + o.h, threshold)) xEdges.push(o.x, o.x + o.w);
    if (rangesNear(left, right, o.x, o.x + o.w, threshold)) yEdges.push(o.y, o.y + o.h);
  }
  if (dir.includes('e')) right = nearest(right, xEdges, threshold);
  if (dir.includes('w')) left = nearest(left, xEdges, threshold);
  if (dir.includes('s')) bottom = nearest(bottom, yEdges, threshold);
  if (dir.includes('n')) top = nearest(top, yEdges, threshold);
  if (right - left < Math.min(min.minWidth ?? DEFAULT_MIN_WIDTH, vp.width)) return rect;
  if (bottom - top < Math.min(min.minHeight ?? DEFAULT_MIN_HEIGHT, vp.height)) return rect;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

// ── Maximize / restore ─────────────────────────────────────────────────────

/**
 * Maximize a panel into the free area. `current` is its on-screen rect,
 * restored later; fromDock=true means restore puts it back in its dock.
 */
export function maximizePanel(
  layout: PanelLayout,
  id: string,
  free: Rect,
  current: Rect,
  fromDock: boolean,
): PanelLayout {
  return bringToFront(
    patchPanel(layout, id, {
      mode: 'floating',
      rect: { ...free },
      maximized: true,
      restoreRect: fromDock ? null : { ...current },
      autoHeight: false,
      minimized: false,
    }),
    id,
  );
}

/** Undo maximizePanel: back to the remembered rect, or to the dock. */
export function restorePanel(layout: PanelLayout, def: PanelDefinition): PanelLayout {
  const s = resolvePanelState(layout, def);
  if (!s.maximized) return layout;
  if (!s.restoreRect) return dockPanel(layout, def);
  return patchPanel(layout, def.id, { rect: s.restoreRect, maximized: false, restoreRect: null });
}

// ── Validation / persistence ────────────────────────────────────────────────

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function sanitizeRect(v: unknown): Rect | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (![r.x, r.y, r.w, r.h].every(isFiniteNum)) return null;
  if ((r.w as number) <= 0 || (r.h as number) <= 0) return null;
  return { x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number };
}

function sanitizePanel(v: unknown): Partial<PanelState> | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  const out: Partial<PanelState> = {};
  if (p.mode === 'docked' || p.mode === 'floating') out.mode = p.mode;
  if (p.dock === 'left' || p.dock === 'right') out.dock = p.dock;
  const rect = sanitizeRect(p.rect);
  if (rect) out.rect = rect;
  if (isFiniteNum(p.dockHeight) && p.dockHeight > 0) out.dockHeight = p.dockHeight;
  if (typeof p.minimized === 'boolean') out.minimized = p.minimized;
  if (typeof p.closed === 'boolean') out.closed = p.closed;
  if (isFiniteNum(p.z) && p.z >= 0) out.z = Math.floor(p.z);
  if (typeof p.autoHeight === 'boolean') out.autoHeight = p.autoHeight;
  if (typeof p.maximized === 'boolean') out.maximized = p.maximized;
  const restore = sanitizeRect(p.restoreRect);
  if (restore) out.restoreRect = restore;
  // poppedOut deliberately dropped: a reload cannot reopen the window.
  return out;
}

/** Turn arbitrary parsed JSON into a valid layout; garbage → defaults. */
export function sanitizeLayout(raw: unknown): PanelLayout {
  const layout = createDefaultLayout();
  if (!raw || typeof raw !== 'object') return layout;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return layout;
  if (r.panels && typeof r.panels === 'object') {
    for (const [id, v] of Object.entries(r.panels as Record<string, unknown>)) {
      const p = sanitizePanel(v);
      if (p) layout.panels[id] = p;
    }
  }
  if (r.docks && typeof r.docks === 'object') {
    const d = r.docks as Record<string, unknown>;
    for (const side of ['left', 'right'] as const) {
      const w = (d[side] as Record<string, unknown> | undefined)?.width;
      if (isFiniteNum(w)) layout.docks[side] = { width: clampDockWidth(w) };
    }
  }
  return layout;
}

function defaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadPanelLayout(storage: Storage | null = defaultStorage()): PanelLayout {
  if (!storage) return createDefaultLayout();
  try {
    const raw = storage.getItem(PANEL_LAYOUT_STORAGE_KEY);
    if (!raw) return createDefaultLayout();
    return sanitizeLayout(JSON.parse(raw));
  } catch {
    return createDefaultLayout();
  }
}

export function savePanelLayout(layout: PanelLayout, storage: Storage | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    const panels: PanelLayout['panels'] = {};
    for (const [id, p] of Object.entries(layout.panels)) {
      const { poppedOut: _drop, ...rest } = p;
      void _drop;
      panels[id] = rest;
    }
    storage.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify({ ...layout, panels }));
    return true;
  } catch {
    return false;
  }
}

export function clearPanelLayout(storage: Storage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(PANEL_LAYOUT_STORAGE_KEY);
  } catch {
    /* non-fatal */
  }
}

// ── Presets ────────────────────────────────────────────────────────────────

export type PanelPresetId = 'default' | 'map-focus' | 'analyst-wide';

export interface PanelPreset {
  id: PanelPresetId;
  label: string;
  description: string;
  build: (defs: PanelDefinition[], vp: Viewport) => PanelLayout;
}

export const PANEL_PRESETS: PanelPreset[] = [
  {
    id: 'default',
    label: 'Default',
    description: 'Every panel back in its original slot',
    build: () => createDefaultLayout(),
  },
  {
    id: 'map-focus',
    label: 'Map focus',
    description: 'Narrow docks, every panel collapsed to its title bar',
    build: (defs) => {
      const layout = createDefaultLayout();
      layout.docks = { left: { width: MIN_DOCK_WIDTH }, right: { width: MIN_DOCK_WIDTH + 40 } };
      for (const def of defs) {
        layout.panels[def.id] = { minimized: true };
      }
      return layout;
    },
  },
  {
    id: 'analyst-wide',
    label: 'Analyst wide',
    description: 'Wide docks, primary panels open full height, tools collapsed',
    build: (defs, vp) => {
      const layout = createDefaultLayout();
      layout.docks = {
        left: { width: clampDockWidth(420, vp) },
        right: { width: clampDockWidth(Math.round(vp.width * 0.36), vp) },
      };
      for (const def of defs) {
        layout.panels[def.id] = { minimized: def.role !== 'primary' };
      }
      return layout;
    },
  },
];

export function buildPreset(id: PanelPresetId, defs: PanelDefinition[], vp: Viewport): PanelLayout {
  const preset = PANEL_PRESETS.find((p) => p.id === id) ?? PANEL_PRESETS[0];
  return preset.build(defs, vp);
}
