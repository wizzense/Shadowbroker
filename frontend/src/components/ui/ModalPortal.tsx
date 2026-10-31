'use client';

/**
 * ModalPortal — render a modal/overlay at the document root instead of in
 * place.
 *
 * Why: HUD panels live inside dock columns (CSS transform for the slide
 * animation) and the floating-panel layer (its own stacking context at
 * z-8500). A `position: fixed` overlay rendered inside one of them is
 * (a) positioned relative to the transformed dock, not the viewport, and
 * (b) capped by the ancestor's stacking context, so a floating panel can
 * cover it. Portalling to <body> escapes both.
 *
 * The target is the body of the document the anchor currently lives in, so
 * a modal opened from a popped-out panel appears in that popup window.
 *
 * Z tiers (see app/page.tsx): docks 200 < floats 8500 < offline banner 9000
 * < MODAL_Z (9998+).
 */

import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Lowest z-index for modal surfaces; everything a panel opens goes at or above it. */
export const MODAL_Z = 9998;

export default function ModalPortal({ children }: { children: ReactNode }) {
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  // Render into the main document on the very first pass (modals centre
  // themselves in a mount-time layout effect, so the portal must exist
  // immediately); switch to the anchor's document once known (popout).
  const body =
    anchor?.ownerDocument?.body ?? (typeof document !== 'undefined' ? document.body : null);
  return (
    <>
      <span ref={setAnchor} hidden data-modal-portal-anchor="" />
      {body ? createPortal(children, body) : null}
    </>
  );
}
