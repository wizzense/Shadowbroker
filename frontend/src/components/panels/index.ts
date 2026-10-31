/**
 * Panel workspace — movable, resizable, dockable, pop-out HUD panels.
 *
 * Add a panel from anywhere inside <PanelWorkspaceProvider>:
 *
 *   import { FloatingPanel } from '@/components/panels';
 *   <FloatingPanel id="civic" title="CIVIC DATA" defaultDock="right" order={25}>
 *     <CivicPanel />
 *   </FloatingPanel>
 *
 * Start floating instead of docked:
 *   <FloatingPanel id="agent-chat" title="AGENT CHAT" defaultDock={null}
 *     defaultRect={(vp) => ({ x: vp.width - 460, y: 120, w: 420, h: 560 })}>
 */
export { default as FloatingPanel } from './FloatingPanel';
export type { FloatingPanelProps } from './FloatingPanel';
export { PanelWorkspaceProvider, usePanelWorkspace, useDockWidth } from './PanelWorkspace';
export { PanelDock, PanelFloatLayer, PanelsMenu } from './PanelDock';
