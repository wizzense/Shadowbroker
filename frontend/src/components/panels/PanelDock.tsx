'use client';

/**
 * PanelDock — a side column that docked panels portal into, plus the
 * floating layer and the PANELS menu.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from '@/lib/motion';
import { LayoutGrid, RotateCcw, Check } from 'lucide-react';
import {
  PANEL_PRESETS,
  bringToFront,
  clampDockWidth,
  patchPanel,
  resolvePanelState,
  setDockWidth,
  type DockSide,
} from '@/lib/panelLayout';
import { usePanelWorkspace } from './PanelWorkspace';

const SLIDE_GAP = 40;

export interface PanelDockProps {
  side: DockSide;
  /** false = slid off-screen (the LAYERS / INTEL edge tabs). */
  open: boolean;
  /** Tailwind positioning for the column (top/bottom/edge offsets, z). */
  className?: string;
  /** Fixed, non-panel content pinned above the panels (e.g. top controls). */
  children?: React.ReactNode;
}

export function PanelDock({ side, open, className = '', children }: PanelDockProps) {
  const { layout, setDockEl, update, viewport } = usePanelWorkspace();
  const width = layout.docks[side].width;
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const w = liveWidth ?? width;
  const ref = useCallback((el: HTMLDivElement | null) => setDockEl(side, el), [setDockEl, side]);
  const vpRef = useRef(viewport);
  vpRef.current = viewport;

  const beginWidthDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const sx = e.clientX;
    const startW = w;
    const pointerId = e.pointerId;
    let next: number | null = null;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - sx;
      next = clampDockWidth(side === 'left' ? startW + dx : startW - dx, vpRef.current);
      setLiveWidth(next);
    };
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      setLiveWidth(null);
      if (next !== null) {
        const n = next;
        update((l) => setDockWidth(l, side, n, vpRef.current));
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  };

  const hiddenX = side === 'left' ? -(w + SLIDE_GAP) : w + SLIDE_GAP;

  return (
    <motion.div
      className={`absolute pointer-events-none hud-zone ${className}`}
      style={{ width: w }}
      animate={{ x: open ? 0 : hiddenX }}
      transition={{ type: 'spring', damping: 30, stiffness: 250 }}
      data-panel-dock={side}
    >
      <div
        ref={ref}
        className={`h-full flex flex-col ${side === 'left' ? 'gap-3 pl-2 pr-2' : 'gap-4 pr-2 pl-2'} overflow-y-auto styled-scrollbar pointer-events-auto`}
        // Left dock keeps its scrollbar on the outer (left) edge, as before.
        style={{ direction: side === 'left' ? 'rtl' : 'ltr' }}
      >
        {children ? (
          <div className="flex flex-col gap-4 flex-shrink-0" style={{ order: -1000, direction: 'ltr' }}>
            {children}
          </div>
        ) : null}
      </div>
      <div
        className={`absolute top-0 bottom-0 w-2 cursor-ew-resize pointer-events-auto group ${side === 'left' ? '-right-2' : '-left-2'}`}
        style={{ touchAction: 'none' }}
        title="Drag to resize column; double-click to reset"
        onPointerDown={beginWidthDrag}
        onDoubleClick={() => update((l) => setDockWidth(l, side, side === 'left' ? 320 : 400))}
        data-dock-resize={side}
      >
        <div className="mx-auto h-full w-[2px] bg-transparent group-hover:bg-cyan-500/40 transition-colors" />
      </div>
    </motion.div>
  );
}

/** Full-viewport layer that floating panels portal into. */
export function PanelFloatLayer({ className = '' }: { className?: string }) {
  const { setFloatEl } = usePanelWorkspace();
  return <div ref={setFloatEl} className={`absolute inset-0 pointer-events-none hud-zone ${className}`} data-panel-float-layer />;
}

/** PANELS menu: reopen/raise any registered panel, presets, reset. */
export function PanelsMenu({ className = '' }: { className?: string }) {
  const { definitions, layout, update, applyPreset, resetLayout, arrangeFloats } = usePanelWorkspace();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const closedCount = definitions.filter((d) => resolvePanelState(layout, d).closed).length;
  const floatingCount = definitions.filter((d) => {
    const s = resolvePanelState(layout, d);
    return s.mode === 'floating' && !s.closed && !s.poppedOut;
  }).length;

  return (
    <div ref={rootRef} className={`relative pointer-events-auto hud-zone ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2.5 py-1 bg-[#05090d]/90 border border-cyan-900/50 text-cyan-500 hover:text-cyan-300 hover:border-cyan-600/60 transition-colors"
        aria-expanded={open}
        aria-haspopup="menu"
        title="Show, hide and arrange panels"
      >
        <LayoutGrid size={11} />
        <span className="text-[9px] font-mono tracking-[0.25em] font-bold">PANELS</span>
        {closedCount > 0 && <span className="text-[9px] font-mono text-amber-400">{closedCount} HIDDEN</span>}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-1/2 -translate-x-1/2 mt-1 w-64 max-h-[70vh] overflow-y-auto styled-scrollbar bg-[#05090d]/95 border border-cyan-900/60 shadow-[0_8px_32px_rgba(0,0,0,0.7)] font-mono text-[10px] z-50"
        >
          <div className="px-3 pt-2 pb-1 text-[9px] tracking-[0.25em] text-cyan-700">PANELS</div>
          {definitions.map((d) => {
            const s = resolvePanelState(layout, d);
            const where = s.poppedOut ? 'WINDOW' : s.mode === 'floating' ? 'FLOAT' : s.dock.toUpperCase();
            return (
              <button
                key={d.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={!s.closed}
                onClick={() =>
                  update((l) =>
                    s.closed
                      ? bringToFront(patchPanel(l, d.id, { closed: false, minimized: false }), d.id)
                      : patchPanel(l, d.id, { closed: true, poppedOut: false }),
                  )
                }
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-cyan-950/50 transition-colors"
              >
                <span className={`w-3 h-3 border flex items-center justify-center ${s.closed ? 'border-gray-700' : 'border-cyan-600 text-cyan-300'}`}>
                  {!s.closed && <Check size={9} />}
                </span>
                <span className={`flex-1 truncate tracking-wider ${s.closed ? 'text-gray-500' : 'text-cyan-300'}`}>{d.title}</span>
                <span className="text-[8px] text-cyan-800 tracking-widest">{s.closed ? '' : s.minimized ? 'MIN' : where}</span>
              </button>
            );
          })}
          <div className="mt-1 border-t border-cyan-900/50 px-3 pt-2 pb-1 text-[9px] tracking-[0.25em] text-cyan-700">
            FLOATING ({floatingCount})
          </div>
          {(['tile', 'cascade'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              disabled={floatingCount === 0}
              title={
                kind === 'tile'
                  ? 'Arrange floating panels in a grid over the free map area'
                  : 'Stack floating panels diagonally over the free map area'
              }
              onClick={() => {
                arrangeFloats(kind);
                setOpen(false);
              }}
              className="w-full px-3 py-1.5 text-left text-cyan-400 tracking-wider hover:bg-cyan-950/50 transition-colors disabled:text-gray-600 disabled:hover:bg-transparent"
            >
              {kind === 'tile' ? 'TILE' : 'CASCADE'}
            </button>
          ))}
          <div className="mt-1 border-t border-cyan-900/50 px-3 pt-2 pb-1 text-[9px] tracking-[0.25em] text-cyan-700">LAYOUT</div>
          {PANEL_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitem"
              title={p.description}
              onClick={() => {
                applyPreset(p.id);
                setOpen(false);
              }}
              className="w-full px-3 py-1.5 text-left text-cyan-400 tracking-wider hover:bg-cyan-950/50 transition-colors"
            >
              {p.label.toUpperCase()}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              resetLayout();
              setOpen(false);
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-amber-400/90 tracking-wider hover:bg-amber-950/30 border-t border-cyan-900/50 transition-colors"
          >
            <RotateCcw size={10} /> RESET LAYOUT
          </button>
        </div>
      )}
    </div>
  );
}
