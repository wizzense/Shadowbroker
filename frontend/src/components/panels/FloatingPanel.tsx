'use client';

/**
 * FloatingPanel — the shell every HUD panel lives in.
 *
 * Docked: rendered (via portal) into its dock column in `order`; the bottom
 * edge resizes its height. Floating: absolute inside the floating layer;
 * drag by the title bar, resize from any edge or corner, click to raise.
 * Popped out: rendered into a separate browser window.
 *
 * The panel body is portalled into ONE persistent DOM node that is physically
 * moved between dock / floating layer / popup, so docking, undocking and
 * popping out never remount the panel (a running chat or search survives).
 * Children also stay mounted while collapsed.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, GripVertical, Minus, Move, PanelLeft, PanelRight, Plus, X } from 'lucide-react';
import {
  bringToFront,
  clampRect,
  definePanel,
  dockPanel,
  floatPanel,
  patchPanel,
  resizeRect,
  resolvePanelState,
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
  /** Floating rect used when undocked without a remembered one. */
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

type Gesture =
  | { kind: 'move'; sx: number; sy: number; start: Rect; armed: boolean }
  | { kind: 'resize'; sx: number; sy: number; start: Rect; dir: ResizeDir }
  | { kind: 'dock-resize'; sy: number; startH: number; maxH: number };

const RESIZE_HANDLES: { dir: ResizeDir; className: string; cursor: string }[] = [
  { dir: 'n', className: 'top-0 left-2 right-2 h-1.5 -translate-y-1/2', cursor: 'ns-resize' },
  { dir: 's', className: 'bottom-0 left-2 right-2 h-1.5 translate-y-1/2', cursor: 'ns-resize' },
  { dir: 'e', className: 'right-0 top-2 bottom-2 w-1.5 translate-x-1/2', cursor: 'ew-resize' },
  { dir: 'w', className: 'left-0 top-2 bottom-2 w-1.5 -translate-x-1/2', cursor: 'ew-resize' },
  { dir: 'ne', className: 'top-0 right-0 w-3 h-3 -translate-y-1/2 translate-x-1/2', cursor: 'nesw-resize' },
  { dir: 'nw', className: 'top-0 left-0 w-3 h-3 -translate-y-1/2 -translate-x-1/2', cursor: 'nwse-resize' },
  { dir: 'se', className: 'bottom-0 right-0 w-3.5 h-3.5', cursor: 'nwse-resize' },
  { dir: 'sw', className: 'bottom-0 left-0 w-3 h-3 translate-y-1/2 -translate-x-1/2', cursor: 'nesw-resize' },
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

function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('button, input, select, textarea, a') !== null;
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
  const { register, update, viewport } = ws;

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

  // ── actions ──────────────────────────────────────────────────────────────
  const toggleMinimized = useCallback(
    () => update((l) => patchPanel(l, id, { minimized: !resolvePanelState(l, def).minimized })),
    [update, id, def],
  );
  const close = useCallback(() => update((l) => patchPanel(l, id, { closed: true, poppedOut: false })), [update, id]);
  const dockBack = useCallback(() => update((l) => dockPanel(l, def)), [update, def]);
  const undock = useCallback(() => {
    const box = rootRef.current?.getBoundingClientRect();
    const rect =
      state.rect ??
      (box ? { x: box.left + 24, y: box.top + 24, w: box.width, h: Math.max(box.height, 320) } : def.defaultRect(viewport));
    update((l) => floatPanel(l, id, clampRect(rect, viewport, def)));
  }, [update, id, def, state.rect, viewport]);
  const popOut = useCallback(() => {
    const box = rootRef.current?.getBoundingClientRect();
    const ok = openPanelPopout(id, { w: Math.max(box?.width ?? 420, 380), h: Math.max(box?.height ?? 600, 520) });
    if (ok) update((l) => patchPanel(l, id, { poppedOut: true, minimized: false }));
  }, [update, id]);
  const popIn = useCallback(() => update((l) => patchPanel(l, id, { poppedOut: false })), [update, id]);

  // ── pointer gestures (mouse, pen, touch) on window listeners ─────────────
  const runGesture = useCallback(
    (g: Gesture, pointerId: number) => {
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
          rect = clampRect({ ...g.start, x: g.start.x + dx, y: g.start.y + dy }, vp, d);
          setLiveRect(rect);
        } else if (g.kind === 'resize') {
          rect = resizeRect(g.start, g.dir, ev.clientX - g.sx, ev.clientY - g.sy, vp, d);
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
        if (rect) {
          const r = rect;
          update((l) => floatPanel(l, id, r));
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
    },
    [update, id],
  );

  const beginMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || isInteractive(e.target)) return;
    const box = rootRef.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    const docked = state.mode === 'docked';
    const start: Rect = docked
      ? { x: box.left, y: box.top, w: box.width, h: Math.max(Math.min(box.height, viewport.height * 0.8), 240) }
      : floatingRect;
    runGesture({ kind: 'move', sx: e.clientX, sy: e.clientY, start, armed: false }, e.pointerId);
  };

  const beginResize = (dir: ResizeDir) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    runGesture({ kind: 'resize', sx: e.clientX, sy: e.clientY, start: floatingRect, dir }, e.pointerId);
  };

  const beginDockResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const box = rootRef.current?.getBoundingClientRect();
    if (!box) return;
    const dockEl = ws.dockEls[state.dock];
    const maxH = dockEl ? dockEl.getBoundingClientRect().height : viewport.height;
    runGesture({ kind: 'dock-resize', sy: e.clientY, startH: box.height, maxH }, e.pointerId);
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
        if (!isInteractive(e.target) && !state.poppedOut) toggleMinimized();
      }}
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
      shell = createPortal(
        <div
          ref={rootRef}
          data-panel-id={id}
          data-panel-mode="floating"
          className="absolute pointer-events-auto flex flex-col shadow-[0_8px_32px_rgba(0,0,0,0.6)]"
          style={{
            left: r.x,
            top: r.y,
            width: r.w,
            height: hideBody ? undefined : r.h,
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
          {!hideBody &&
            RESIZE_HANDLES.map((h) => (
              <div
                key={h.dir}
                className={`absolute ${h.className} z-10`}
                style={{ cursor: h.cursor, touchAction: 'none' }}
                onPointerDown={beginResize(h.dir)}
                data-resize={h.dir}
              />
            ))}
        </div>,
        target,
      );
    }
  } else {
    const target = ws.dockEls[state.dock];
    if (target) {
      const fixedH = liveDockH ?? state.dockHeight;
      const grows = dockGrow && fixedH === null && !hideBody;
      shell = createPortal(
        <div
          ref={rootRef}
          data-panel-id={id}
          data-panel-mode="docked"
          className={`relative pointer-events-auto flex flex-col ${grows ? 'flex-1 min-h-[300px]' : 'flex-shrink-0'}`}
          style={{ order, height: fixedH !== null && !hideBody ? fixedH : undefined, direction: 'ltr' }}
        >
          {header}
          {inlineSlot}
          {parkedSlot}
          {popout}
          {!hideBody && (
            <div
              className="absolute left-0 right-0 bottom-0 h-2 translate-y-1/2 cursor-ns-resize z-10 group"
              style={{ touchAction: 'none' }}
              title="Drag to resize; double-click for natural height"
              onPointerDown={beginDockResize}
              onDoubleClick={() => update((l) => patchPanel(l, id, { dockHeight: null }))}
              data-resize="dock-s"
            >
              <div className="mx-auto mt-[3px] h-[2px] w-10 bg-transparent group-hover:bg-cyan-500/70 transition-colors" />
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
