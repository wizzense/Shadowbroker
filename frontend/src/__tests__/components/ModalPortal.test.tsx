import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ModalPortal, { MODAL_Z } from '@/components/ui/ModalPortal';
import AdvancedFilterModal from '@/components/AdvancedFilterModal';
import ConfirmDialog from '@/components/ui/ConfirmDialog';

vi.mock('@/lib/motion', () => ({
  motion: {
    div: ({ children, ...props }: React.ComponentProps<'div'> & Record<string, unknown>) => {
      const rest = { ...props };
      for (const key of ['initial', 'animate', 'exit', 'transition']) delete rest[key];
      return <div {...(rest as React.ComponentProps<'div'>)}>{children}</div>;
    },
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

/** Stand-in for a dock column / the floating layer: a transform + its own stacking context. */
function PanelHost({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid="panel-host" style={{ transform: 'translateX(0px)', position: 'absolute', zIndex: 8500 }}>
      {children}
    </div>
  );
}

describe('modals opened from inside a panel escape it', () => {
  afterEach(() => cleanup());

  it('ModalPortal renders its children as a direct child of <body>', () => {
    render(
      <PanelHost>
        <ModalPortal>
          <div data-testid="overlay">x</div>
        </ModalPortal>
      </PanelHost>,
    );
    const overlay = screen.getByTestId('overlay');
    expect(overlay.parentElement).toBe(document.body);
    expect(screen.getByTestId('panel-host').contains(overlay)).toBe(false);
    expect(MODAL_Z).toBeGreaterThanOrEqual(9998);
  });

  it('the advanced filter dialog is not trapped in its panel and sits at the modal tier', () => {
    render(
      <PanelHost>
        <AdvancedFilterModal
          title="MARITIME VESSELS"
          icon={null}
          accentColor="#3B82F6"
          accentColorName="blue"
          fields={[{ key: 'ship_name', label: 'VESSEL NAME', options: ['A', 'B'] }]}
          activeFilters={{}}
          onApply={vi.fn()}
          onClose={vi.fn()}
        />
      </PanelHost>,
    );
    const overlay = document.body.querySelector(':scope > .fixed.inset-0') as HTMLElement | null;
    expect(overlay).not.toBeNull();
    expect(screen.getByTestId('panel-host').contains(overlay)).toBe(false);
    expect(overlay!.className).toMatch(/z-\[(\d+)\]/);
    const z = Number(/z-\[(\d+)\]/.exec(overlay!.className)![1]);
    expect(z).toBeGreaterThanOrEqual(MODAL_Z);
  });

  it('ConfirmDialog escapes its panel too', () => {
    render(
      <PanelHost>
        <ConfirmDialog open title="Sure?" message="m" onConfirm={vi.fn()} onCancel={vi.fn()} />
      </PanelHost>,
    );
    const title = screen.getByText('Sure?');
    expect(screen.getByTestId('panel-host').contains(title)).toBe(false);
  });
});

/**
 * Guard: components that render inside HUD panels must not put a full-screen
 * `fixed inset-0` overlay in place — it would be clipped to the transformed
 * dock and covered by floating panels. Each such file must route overlays
 * through ModalPortal (or createPortal).
 */
const PANEL_HOSTED = [
  'components/FilterPanel.tsx',
  'components/AdvancedFilterModal.tsx',
  'components/WorldviewLeftPanel.tsx',
  'components/MeshChat/index.tsx',
  'components/ShodanPanel.tsx',
  'components/ReconPanel.tsx',
  'components/ScmPanel.tsx',
  'components/CyberThreatPanel.tsx',
  'components/CivicPanel.tsx',
  'components/AIIntelPanel.tsx',
  'components/TimelinePanel.tsx',
  'components/NewsFeed.tsx',
  'components/TopRightControls.tsx',
  'components/AgentChatPanel.tsx',
  'components/ui/ConfirmDialog.tsx',
  'components/ui/KiwiSdrConsentDialog.tsx',
];

describe('panel-hosted components portal their overlays', () => {
  const src = path.resolve(__dirname, '../..');
  for (const rel of PANEL_HOSTED) {
    it(rel, () => {
      const file = path.join(src, rel);
      if (!fs.existsSync(file)) return; // a panel that was removed is not a violation
      const text = fs.readFileSync(file, 'utf-8');
      const hasOverlay = /fixed inset-0|position:\s*'fixed',\s*\n?\s*inset:\s*0/.test(text);
      if (!hasOverlay) return;
      expect(/ModalPortal|createPortal/.test(text)).toBe(true);
    });
  }
});
