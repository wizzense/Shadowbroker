'use client';

/**
 * FloatingPanel — the shell every HUD panel lives in.
 *
 * Docked: rendered (via portal) into its dock column in `order`. Each docked
 * panel is height-bounded (content scrolls inside it, never under the next
 * panel) and has a visible splitter bar below it to set its height.
 * Floating: absolute inside the floating layer; drag by the title bar (snaps
 * to viewport edges and other panels within 12 px), resize from any edge or
 * the corner grip, double-click the title to maximize/restore. A panel that
 * is floated for the first time lands in free map space (never over a dock)
 * and sizes to its content up to 85% of the viewport height.
 * Popped out: rendered into a separate browser window.
 *
 * The panel body is portalled into ONE persistent DOM node that is physically
 * moved between dock / floating layer / popup, so docking, undocking and
 * popping out never remount the panel (a running chat or search survives).
 * Children also stay mounted while collapsed.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ExternalLink,
  GripVertical,
  Maximize2,
  Minimize2,
  Minus,
  Move,
  PanelLeft,
  PanelRight,
  Plus,
  X,
} from 'lucide-react';
import {
  HEADER_HEIGHT,
  MAX_AUTO_HEIGHT_FRACTION,
  bringToFront,
  clampRect,
  definePanel,
  dockPanel,
  maximizePanel,
  overlapsAny,
  patchPanel,
  placeNewFloat,
  resizeRect,
  resolvePanelState,
  restorePanel,
  snapMove,
  snapResize,
  topZ,
  type DockSide,
  type PanelDefinition,
  type PanelRole,
  type Rect,
  type ResizeDir,
  type Viewport,
} from '@/lib/panelLayout';
import { usePanelWorkspace } from './PanelWorkspace';
import { PopoutPortal, openPanelPopout } from './PopoutWindow';

export interface FloatingPanelProps {
  /** Stable id; also the persistence key. */
  id: string;
  /** Shown in the title bar and the Panels menu. */
  title: string;
  /** Dock the panel starts in; null = starts floating at defaultRect. Default 'left'. */
  defaultDock?: DockSide | null;
  /** Position inside the dock column (ascending, top to bottom). Default 100. */
  order?: number;
  /** Floating rect used when the panel STARTS floating (defaultDock null). */
  defaultRect?: (vp: Viewport) => Rect;
  minWidth?: number;
  minHeight?: number;
  /** 'primary' panels stay open in the Analyst preset; 'tool' panels collapse. */
  role?: PanelRole;
  /** While docked with no fixed height, take the remaining column height. */
  dockGrow?: boolean;
  children: React.ReactNode;
}

const DRAG_THRESHOLD = 4;
const FLOAT_Z_BASE = 10;
const SPLITTER_H = 6;

type Gesture =
  | { kind: 'move'; sx: number; sy: number; start: Rect; armed: boolean; others: Rect[] }
  | { kind: 'resize'; sx: number; sy: number; start: Rect; dir: ResizeDir; others: Rect[] }
  | { kind: 'dock-resize'; sy: number; startH: number; maxH: number };

const EDGE = 8; // px hit area of edge handles
const RESIZE_HANDLES: { dir: ResizeDir; style: React.CSSProperties; cursor: string }[] = [
  { dir: 'n', style: { top: -EDGE / 2, left: EDGE, right: EDGE, height: EDGE }, cursor: 'ns-resize' },
  { dir: 's', style: { bottom: -EDGE / 2, left: EDGE, right: 18, height: EDGE }, cursor: 'ns-resize' },
  { dir: 'e', style: { right: -EDGE / 2, top: EDGE, bottom: 18, width: EDGE }, cursor: 'ew-resize' },
  { dir: 'w', style: { left: -EDGE / 2, top: EDGE, bottom: EDGE, width: EDGE }, cursor: 'ew-resize' },
  { dir: 'ne', style: { top: -EDGE / 2, right: -EDGE / 2, width: EDGE * 1.5, height: EDGE * 1.5 }, cursor: 'nesw-resize' },
  { dir: 'nw', style: { top: -EDGE / 2, left: -EDGE / 2, width: EDGE * 1.5, height: EDGE * 1.5 }, cursor: 'nwse-resize' },
  { dir: 'sw', style: { bottom: -EDGE / 2, left: -EDGE / 2, width: EDGE * 1.5, height: EDGE * 1.5 }, cursor: 'nesw-resize' },
  // Corner grip: large, visible (see CornerGrip), sits inside the panel.
  { dir: 'se', style: { bottom: 0, right: 0, width: 18, height: 18 }, cursor: 'nwse-resize' },
];

function HeaderButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="w-5 h-5 flex items-center justify-center text-cyan-700 hover:text-cyan-300 hover:bg-cyan-950/60 transition-colors"
    >
      {children}
    </button>
  );
}

/** Visible diagonal grip in the bottom-right corner of a floating panel. */
function CornerGrip() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="absolute bottom-[2px] right-[2px] pointer-events-none text-cyan-500/70" aria-hidden>
      <path d="M13 5 L5 13 M13 9 L9 13 M13 1 L1 13" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('button, input, select, textarea, a') !== null;
}

function domRect(el: Element | null | undefined): Rect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
}

export default function FloatingPanel({
  id,
  title,
  defaultDock = 'left',
  order = 100,
  defaultRect,
  minWidth,
  minHeight,
  role,
  dockGrow = false,
  children,
}: FloatingPanelProps) {
  const ws = usePanelWorkspace();
  const { register, update, viewport, measureFreeArea, measureObstacles } = ws;

  // defaultRect is usually an inline arrow; keep the definition stable anyway.
  const defaultRectRef = useRef(defaultRect);
  defaultRectRef.current = defaultRect;
  const def = useMemo<PanelDefinition>(() => {
    const base = definePanel({ id, title, defaultDock, order, minWidth, minHeight, role });
    const fallback = base.defaultRect;
    return { ...base, defaultRect: (vp: Viewport) => (defaultRectRef.current ?? fallback)(vp) };
  }, [id, title, defaultDock, order, minWidth, minHeight, role]);

  useEffect(() => register(def), [register, def]);

  // Persistent body host — moved between dock / float layer / popup.
  const [bodyHost, setBodyHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = document.createElement('div');
    el.style.cssText = 'display:flex;flex-direction:column;flex:1 1 auto;min-height:0;';
    el.dataset.panelBody = id;
    setBodyHost(el);
    return () => el.remove();
  }, [id]);
  const attachBody = useCallback(
    (slot: HTMLDivElement | null) => {
      if (slot && bodyHost && bodyHost.parentNode !== slot) slot.appendChild(bodyHost);
    },
    [bodyHost],
  );

  const state = resolvePanelState(ws.layout, def);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [liveRect, setLiveRect] = useState<Rect | null>(null);
  const [liveDockH, setLiveDockH] = useState<number | null>(null);

  const floatingRect = useMemo(
    () => clampRect(state.rect ?? def.defaultRect(viewport), viewport, def),
    [state.rect, def, viewport],
  );

  // Latest values for window-level gesture listeners.
  const latest = useRef({ viewport, def });
  latest.current = { viewport, def };

  const raise = useCallback(() => update((l) => bringToFront(l, id)), [update, id]);

  /** The rect a floating panel actually occupies on screen (auto-height aware). */
  const currentFloatRect = useCallback((): Rect => {
    const r = domRect(rootRef.current);
    return r && state.mode === 'floating' ? r : floatingRect;
  }, [floatingRect, state.mode]);

  // ── actions ──────────────────────────────────────────────────────────────
  const toggleMinimized = useCallback(
    () => update((l) => patchPanel(l, id, { minimized: !resolvePanelState(l, def).minimized })),
    [update, id, def],
  );
  const close = useCallback(() => update((l) => patchPanel(l, id, { closed: true, poppedOut: false })), [update, id]);
  const dockBack = useCallback(() => update((l) => dockPanel(l, def)), [update, def]);

  /**
   * Float a docked panel: into free map space (never over a dock), cascaded
   * away from other floats; height = content (auto, capped at 85% vh) unless
   * it is a fill-the-column panel, which keeps its docked height.
   */
  const undock = useCallback(() => {
    if (state.rect && !overlapsAny(state.rect, measureObstacles(id).docks)) {
      update((l) => bringToFront(patchPanel(l, id, { mode: 'floating', maximized: false }), id));
      return;
    }
    const box = domRect(rootRef.current);
    const vp = latest.current.viewport;
    const capH = Math.round(vp.height * MAX_AUTO_HEIGHT_FRACTION);
    const content = bodyHost?.scrollHeight ?? 0;
    const wantH = dockGrow ? (box?.h ?? capH) : content + HEADER_HEIGHT + 2;
    const size = { w: Math.max(box?.w ?? 380, def.minWidth), h: Math.min(Math.max(wantH, def.minHeight), capH) };
    const rect = placeNewFloat(size, measureFreeArea(), measureObstacles(id).floats, def);
    update((l) =>
      bringToFront(patchPanel(l, id, { mode: 'floating', rect, autoHeight: !dockGrow, maximized: false, minimized: false }), id),
    );
  }, [state.rect, update, id, bodyHost, dockGrow, def, measureFreeArea, measureObstacles]);

  // One-time repair of floats saved by the first panel-workspace build, which
  // undocked panels at the dock's own position (e.g. CIVIC over DATA LAYERS).
  // Those entries never carried `autoHeight`; every newer code path writes it.
  const repairedRef = useRef(false);
  const storedEntry = ws.layout.panels[id];
  useEffect(() => {
    if (repairedRef.current || !ws.floatEl || !storedEntry) return;
    if (storedEntry.mode !== 'floating' || !storedEntry.rect || storedEntry.autoHeight !== undefined) return;
    if (!ws.dockEls.left && !ws.dockEls.right) return;
    repairedRef.current = true;
    const { floats, docks } = measureObstacles(id);
    if (!overlapsAny(storedEntry.rect, docks)) {
      update((l) => patchPanel(l, id, { autoHeight: false }));
      return;
    }
    const rect = placeNewFloat(storedEntry.rect, measureFreeArea(), floats, def);
    update((l) => patchPanel(l, id, { rect, autoHeight: false }));
  }, [storedEntry, ws.floatEl, ws.dockEls, measureObstacles, measureFreeArea, update, id, def]);

  const toggleMaximize = useCallback(() => {
    if (state.maximized) {
      update((l) => restorePanel(l, def));
      return;
    }
    const fromDock = state.mode === 'docked';
    const current = fromDock ? (domRect(rootRef.current) ?? floatingRect) : currentFloatRect();
    update((l) => maximizePanel(l, id, measureFreeArea(), current, fromDock));
  }, [state.maximized, state.mode, update, def, id, floatingRect, currentFloatRect, measureFreeArea]);

  const popOut = useCallback(() => {
    const box = rootRef.current?.getBoundingClientRect();
    const ok = openPanelPopout(id, { w: Math.max(box?.width ?? 420, 380), h: Math.max(box?.height ?? 600, 520) });
    if (ok) update((l) => patchPanel(l, id, { poppedOut: true, minimized: false }));
  }, [update, id]);
  const popIn = useCallback(() => update((l) => patchPanel(l, id, { poppedOut: false })), [update, id]);

  // ── pointer gestures (mouse, pen, touch) on window listeners ─────────────
  const runGesture = useCallback(
    (g: Gesture, pointerId: number, wasDocked: boolean) => {
      let rect: Rect | null = null;
      let dockH: number | null = null;
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const { viewport: vp, def: d } = latest.current;
        if (g.kind === 'move') {
          const dx = ev.clientX - g.sx;
          const dy = ev.clientY - g.sy;
          if (!g.armed) {
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
            g.armed = true;
          }
          rect = snapMove(clampRect({ ...g.start, x: g.start.x + dx, y: g.start.y + dy }, vp, d), vp, g.others);
          setLiveRect(rect);
        } else if (g.kind === 'resize') {
          const raw = resizeRect(g.start, g.dir, ev.clientX - g.sx, ev.clientY - g.sy, vp, d);
          rect = snapResize(raw, g.dir, vp, g.others, d);
          setLiveRect(rect);
        } else {
          dockH = Math.round(Math.min(Math.max(g.startH + (ev.clientY - g.sy), d.minHeight), g.maxH));
          setLiveDockH(dockH);
        }
      };
      const onEnd = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
        if (g.kind === 'dock-resize') {
          setLiveDockH(null);
          if (dockH !== null) {
            const h = dockH;
            update((l) => patchPanel(l, id, { dockHeight: h }));
          }
          return;
        }
        setLiveRect(null);
        if (!rect) return; // a click, not a drag
        const r = rect;
        const patch: Parameters<typeof patchPanel>[2] = { mode: 'floating', rect: r, maximized: false, restoreRect: null };
        if (g.kind === 'resize' && /[ns]/.test(g.dir)) patch.autoHeight = false;
        if (g.kind === 'move' && wasDocked) patch.autoHeight = false;
        update((l) => bringToFront(patchPanel(l, id, patch), id));
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
    },
    [update, id],
  );

  const snapTargets = useCallback(() => {
    const { floats, docks } = measureObstacles(id);
    return [...floats, ...docks];
  }, [measureObstacles, id]);

  const beginMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || isInteractive(e.target)) return;
    const box = domRect(rootRef.current);
    if (!box) return;
    e.preventDefault();
    const docked = state.mode === 'docked';
    const start: Rect = docked
      ? { ...box, h: Math.max(Math.min(box.h, viewport.height * MAX_AUTO_HEIGHT_FRACTION), 240) }
      : currentFloatRect();
    runGesture({ kind: 'move', sx: e.clientX, sy: e.clientY, start, armed: false, others: snapTargets() }, e.pointerId, docked);
  };

  const beginResize = (dir: ResizeDir) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    runGesture(
      { kind: 'resize', sx: e.clientX, sy: e.clientY, start: currentFloatRect(), dir, others: snapTargets() },
      e.pointerId,
      false,
    );
  };

  const beginDockResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const box = rootRef.current?.getBoundingClientRect();
    if (!box) return;
    const dockEl = ws.dockEls[state.dock];
    const maxH = dockEl ? dockEl.getBoundingClientRect().height : viewport.height;
    runGesture({ kind: 'dock-resize', sy: e.clientY, startH: box.height, maxH }, e.pointerId, true);
  };

  if (state.closed || !bodyHost) return null;

  const isFloating = state.mode === 'floating' || liveRect !== null;
  const minimized = state.minimized && !state.poppedOut;
  const hideBody = minimized || state.poppedOut;

  // ── title bar ────────────────────────────────────────────────────────────
  const header = (
    <div
      className="flex items-center gap-1 h-[22px] shrink-0 px-1 bg-[#03080c]/95 border border-cyan-900/50 border-b-0 cursor-grab active:cursor-grabbing select-none"
      style={{ touchAction: 'none' }}
      onPointerDown={beginMove}
      onDoubleClick={(e) => {
        if (!isInteractive(e.target) && !state.poppedOut) toggleMaximize();
      }}
      title="Drag to move · double-click to maximize/restore"
      data-panel-header={id}
    >
      <GripVertical size={11} className="text-cyan-800 shrink-0" />
      <span className="flex-1 min-w-0 truncate text-[9px] font-mono tracking-[0.2em] text-cyan-600/80 font-bold">
        {title}
        {state.poppedOut ? ' · POPPED OUT' : ''}
      </span>
      {state.poppedOut ? (
        <HeaderButton title="Return panel to this window" onClick={popIn}>
          <PanelLeft size={11} />
        </HeaderButton>
      ) : (
        <>
          <HeaderButton title={minimized ? 'Expand panel' : 'Collapse panel'} onClick={toggleMinimized}>
            {minimized ? <Plus size={11} /> : <Minus size={11} />}
          </HeaderButton>
          <HeaderButton title={state.maximized ? 'Restore size' : 'Maximize'} onClick={toggleMaximize}>
            {state.maximized ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
          </HeaderButton>
          {state.mode === 'floating' ? (
            <HeaderButton title="Dock back to default slot" onClick={dockBack}>
              {def.defaultDock === 'right' ? <PanelRight size={11} /> : <PanelLeft size={11} />}
            </HeaderButton>
          ) : (
            <HeaderButton title="Undock (float freely)" onClick={undock}>
              <Move size={11} />
            </HeaderButton>
          )}
          <HeaderButton title="Pop out to a separate window" onClick={popOut}>
            <ExternalLink size={11} />
          </HeaderButton>
        </>
      )}
      <HeaderButton title="Close panel (reopen from the PANELS menu)" onClick={close}>
        <X size={11} />
      </HeaderButton>
    </div>
  );

  const inlineSlot = hideBody ? null : (
    <div ref={attachBody} className="flex-1 min-h-0 flex flex-col overflow-auto styled-scrollbar" />
  );

  // Collapsed: park the body (still mounted) in a hidden slot.
  const parkedSlot = minimized ? <div ref={attachBody} style={{ display: 'none' }} /> : null;

  const popout = state.poppedOut ? (
    <PopoutPortal id={id} title={title} onClosed={popIn}>
      <div ref={attachBody} className="flex-1 min-h-0 flex flex-col overflow-auto" style={{ direction: 'ltr' }} />
    </PopoutPortal>
  ) : null;

  let shell: React.ReactNode = null;
  if (isFloating) {
    const target = ws.floatEl;
    if (target) {
      const r = liveRect ?? floatingRect;
      const auto = state.autoHeight && !state.maximized && !liveRect;
      const capH = Math.min(Math.round(viewport.height * MAX_AUTO_HEIGHT_FRACTION), viewport.height - r.y);
      shell = createPortal(
        <div
          ref={rootRef}
          data-panel-id={id}
          data-panel-mode="floating"
          data-maximized={state.maximized ? 'true' : undefined}
          className="absolute pointer-events-auto flex flex-col overflow-visible bg-[#03080c]/40 shadow-[0_8px_32px_rgba(0,0,0,0.6)] outline outline-1 outline-cyan-900/40"
          style={{
            left: r.x,
            top: r.y,
            width: r.w,
            height: hideBody || auto ? undefined : r.h,
            maxHeight: hideBody ? undefined : auto ? capH : undefined,
            zIndex: FLOAT_Z_BASE + state.z + (liveRect ? 1000 : 0),
            direction: 'ltr',
          }}
          onPointerDownCapture={() => {
            if (state.z === 0 || state.z !== topZ(ws.layout)) raise();
          }}
        >
          {header}
          {inlineSlot}
          {parkedSlot}
          {popout}
          {!hideBody && (
            <>
              {RESIZE_HANDLES.map((h) => (
                <div
                  key={h.dir}
                  className="absolute z-10"
                  style={{ ...h.style, cursor: h.cursor, touchAction: 'none' }}
                  onPointerDown={beginResize(h.dir)}
                  data-resize={h.dir}
                />
              ))}
              <CornerGrip />
            </>
          )}
        </div>,
        target,
      );
    }
  } else {
    const target = ws.dockEls[state.dock];
    if (target) {
      const fixedH = liveDockH ?? state.dockHeight;
      const grows = dockGrow && fixedH === null && !hideBody;
      const heightStyle: React.CSSProperties = hideBody
        ? { flex: '0 0 auto' }
        : fixedH !== null
          ? { flex: `0 0 ${fixedH}px`, height: fixedH }
          : grows
            ? { flex: '1 1 0px', minHeight: Math.max(def.minHeight, 300) }
            : // natural height, bounded (overflow hidden + inner scroll) so it can
              // never spill under the next panel
              { flex: '0 0 auto', maxHeight: '100%' };
      shell = createPortal(
        <div
          ref={rootRef}
          data-panel-id={id}
          data-panel-mode="docked"
          className="relative pointer-events-auto flex flex-col overflow-hidden"
          style={{ order, direction: 'ltr', ...heightStyle }}
        >
          {header}
          {inlineSlot}
          {parkedSlot}
          {popout}
          {!hideBody && (
            <div
              className="shrink-0 flex items-center justify-center cursor-row-resize bg-[#03080c]/90 border border-t-0 border-cyan-900/50 hover:bg-cyan-950/70 group"
              style={{ height: SPLITTER_H, touchAction: 'none' }}
              title="Drag to resize this panel · double-click for automatic height"
              onPointerDown={beginDockResize}
              onDoubleClick={() => update((l) => patchPanel(l, id, { dockHeight: null }))}
              data-resize="dock-s"
              role="separator"
              aria-orientation="horizontal"
              aria-label={`Resize ${title}`}
            >
              <div className="h-[2px] w-8 bg-cyan-800/70 group-hover:bg-cyan-400 transition-colors" />
            </div>
          )}
        </div>,
        target,
      );
    }
  }

  if (!shell) return null;
  // Shell first: its slot ref attaches the body host before the body's own
  // layout effects run, so children measure inside the live document.
  return (
    <>
      {shell}
      {createPortal(children, bodyHost)}
    </>
  );
}
