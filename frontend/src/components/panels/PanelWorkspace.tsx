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
  buildPreset,
  clearPanelLayout,
  createDefaultLayout,
  loadPanelLayout,
  savePanelLayout,
  type DockSide,
  type PanelDefinition,
  type PanelLayout,
  type PanelPresetId,
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
}

const PanelWorkspaceContext = createContext<PanelWorkspaceValue | null>(null);

const FALLBACK_VIEWPORT: Viewport = { width: 1440, height: 900 };

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
    }),
    [layout, viewport, definitions, register, update, dockEls, setDockEl, floatEl, applyPreset, resetLayout],
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
