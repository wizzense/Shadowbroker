'use client';

/**
 * PanelWorkspace — context that owns the persisted HUD layout, the panel
 * registry, the dock column elements and the floating layer.
 *
 * Any component rendered inside <PanelWorkspaceProvider> can add a panel:
 *
 *   <FloatingPanel id="civic" title="CIVIC DATA" defaultDock="right" order={25}>
 *     <CivicPanel />
 *   </FloatingPanel>
 *
 * The panel registers itself on mount, appears in the Panels menu, and its
 * position/size/collapse state is persisted per browser.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  bringToFront,
  buildPreset,
  cascadeRects,
  clearPanelLayout,
  computeFreeArea,
  patchPanel,
  resolvePanelState,
  tileRects,
  createDefaultLayout,
  loadPanelLayout,
  savePanelLayout,
  type DockSide,
  type PanelDefinition,
  type PanelLayout,
  type PanelPresetId,
  type Rect,
  type Viewport,
} from '@/lib/panelLayout';

export interface PanelWorkspaceValue {
  layout: PanelLayout;
  viewport: Viewport;
  /** Registered panels, sorted by dock then order. */
  definitions: PanelDefinition[];
  register: (def: PanelDefinition) => () => void;
  update: (fn: (layout: PanelLayout) => PanelLayout) => void;
  dockEls: Record<DockSide, HTMLElement | null>;
  setDockEl: (side: DockSide, el: HTMLElement | null) => void;
  floatEl: HTMLElement | null;
  setFloatEl: (el: HTMLElement | null) => void;
  applyPreset: (id: PanelPresetId) => void;
  resetLayout: () => void;
  /** Viewport area not covered by the (open) dock columns or header/footer. */
  measureFreeArea: () => Rect;
  /** On-screen rects of floating panels (optionally excluding one) and open docks. */
  measureObstacles: (exceptId?: string) => { floats: Rect[]; docks: Rect[] };
  /** Rearrange every visible floating panel inside the free area. */
  arrangeFloats: (kind: 'tile' | 'cascade') => number;
}

const PanelWorkspaceContext = createContext<PanelWorkspaceValue | null>(null);

const FALLBACK_VIEWPORT: Viewport = { width: 1440, height: 900 };

function toRect(r: DOMRect): Rect {
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
}

function readViewport(): Viewport {
  if (typeof window === 'undefined') return FALLBACK_VIEWPORT;
  return { width: window.innerWidth || FALLBACK_VIEWPORT.width, height: window.innerHeight || FALLBACK_VIEWPORT.height };
}

export function PanelWorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [layout, setLayout] = useState<PanelLayout>(createDefaultLayout);
  const [hydrated, setHydrated] = useState(false);
  const [viewport, setViewport] = useState<Viewport>(FALLBACK_VIEWPORT);
  const [defs, setDefs] = useState<Record<string, PanelDefinition>>({});
  const [dockEls, setDockEls] = useState<Record<DockSide, HTMLElement | null>>({ left: null, right: null });
  const [floatEl, setFloatEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setLayout(loadPanelLayout());
    setHydrated(true);
    setViewport(readViewport());
    const onResize = () => setViewport(readViewport());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Persist (debounced: drags commit once on release, presets burst-write).
  useEffect(() => {
    if (!hydrated) return undefined;
    const id = window.setTimeout(() => savePanelLayout(layout), 150);
    return () => window.clearTimeout(id);
  }, [layout, hydrated]);

  const register = useCallback((def: PanelDefinition) => {
    setDefs((prev) => (prev[def.id] === def ? prev : { ...prev, [def.id]: def }));
    return () => {
      setDefs((prev) => {
        if (prev[def.id] !== def) return prev;
        const next = { ...prev };
        delete next[def.id];
        return next;
      });
    };
  }, []);

  const update = useCallback((fn: (l: PanelLayout) => PanelLayout) => setLayout(fn), []);

  const setDockEl = useCallback((side: DockSide, el: HTMLElement | null) => {
    setDockEls((prev) => (prev[side] === el ? prev : { ...prev, [side]: el }));
  }, []);

  const definitions = useMemo(
    () =>
      Object.values(defs).sort(
        (a, b) =>
          (a.defaultDock ?? 'z').localeCompare(b.defaultDock ?? 'z') || a.order - b.order || a.id.localeCompare(b.id),
      ),
    [defs],
  );

  const definitionsRef = useRef(definitions);
  definitionsRef.current = definitions;

  const applyPreset = useCallback((id: PanelPresetId) => {
    setLayout(buildPreset(id, definitionsRef.current, readViewport()));
  }, []);

  const resetLayout = useCallback(() => {
    clearPanelLayout();
    setLayout(createDefaultLayout());
  }, []);

  const dockElsRef = useRef(dockEls);
  dockElsRef.current = dockEls;
  const floatElRef = useRef(floatEl);
  floatElRef.current = floatEl;

  const measureObstacles = useCallback((exceptId?: string) => {
    const docks: Rect[] = [];
    for (const el of Object.values(dockElsRef.current)) {
      if (el) docks.push(toRect(el.getBoundingClientRect()));
    }
    const floats: Rect[] = [];
    floatElRef.current?.querySelectorAll<HTMLElement>('[data-panel-mode="floating"]').forEach((el) => {
      if (el.dataset.panelId !== exceptId) floats.push(toRect(el.getBoundingClientRect()));
    });
    return { floats, docks };
  }, []);

  const measureFreeArea = useCallback(
    () => computeFreeArea(readViewport(), measureObstacles().docks),
    [measureObstacles],
  );

  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const arrangeFloats = useCallback(
    (kind: 'tile' | 'cascade') => {
      const free = measureFreeArea();
      const floating = definitionsRef.current.filter((d) => {
        const s = resolvePanelState(layoutRef.current, d);
        return s.mode === 'floating' && !s.closed && !s.poppedOut;
      });
      if (floating.length === 0) return 0;
      const sizes = floating.map((d) => {
        const el = floatElRef.current?.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(d.id)}"]`);
        const r = el?.getBoundingClientRect();
        return r ? { w: r.width, h: r.height } : { w: 380, h: 480 };
      });
      const rects = kind === 'tile' ? tileRects(floating.length, free) : cascadeRects(sizes, free);
      setLayout((l) => {
        let next = l;
        floating.forEach((d, i) => {
          next = patchPanel(next, d.id, {
            rect: rects[i],
            autoHeight: false,
            maximized: false,
            restoreRect: null,
            minimized: false,
          });
          next = bringToFront(next, d.id);
        });
        return next;
      });
      return floating.length;
    },
    [measureFreeArea],
  );

  const value = useMemo<PanelWorkspaceValue>(
    () => ({
      layout,
      viewport,
      definitions,
      register,
      update,
      dockEls,
      setDockEl,
      floatEl,
      setFloatEl,
      applyPreset,
      resetLayout,
      measureFreeArea,
      measureObstacles,
      arrangeFloats,
    }),
    [
      layout,
      viewport,
      definitions,
      register,
      update,
      dockEls,
      setDockEl,
      floatEl,
      applyPreset,
      resetLayout,
      measureFreeArea,
      measureObstacles,
      arrangeFloats,
    ],
  );

  return <PanelWorkspaceContext.Provider value={value}>{children}</PanelWorkspaceContext.Provider>;
}

export function usePanelWorkspace(): PanelWorkspaceValue {
  const ctx = useContext(PanelWorkspaceContext);
  if (!ctx) throw new Error('usePanelWorkspace must be used inside <PanelWorkspaceProvider>');
  return ctx;
}

/** Current width of a dock column (px). */
export function useDockWidth(side: DockSide): number {
  return usePanelWorkspace().layout.docks[side].width;
}
