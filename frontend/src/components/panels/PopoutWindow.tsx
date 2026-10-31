'use client';

/**
 * Pop a panel out into its own browser window by portalling its React tree
 * into a blank popup. The popup must be opened synchronously inside the click
 * handler (openPanelPopout) or popup blockers refuse it; the portal component
 * then adopts that window.
 *
 * Stylesheets and the theme attributes (data-theme / data-hud) are mirrored
 * from the opener, including styles that load after the popup opened.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const popups = new Map<string, Window>();
const pendingClose = new Map<string, number>();

/** Open (or focus) the popup for a panel. Returns false if the browser blocked it. */
export function openPanelPopout(id: string, size: { w: number; h: number }): boolean {
  if (typeof window === 'undefined') return false;
  const existing = popups.get(id);
  if (existing && !existing.closed) {
    existing.focus();
    return true;
  }
  const features = `popup=yes,width=${Math.round(size.w)},height=${Math.round(size.h)}`;
  const win = window.open('', `sb-panel-${id}`, features);
  if (!win) return false;
  popups.set(id, win);
  return true;
}

function cloneStyleNode(node: Element, doc: Document): Node | null {
  if (node instanceof HTMLLinkElement) {
    if (node.rel !== 'stylesheet') return null;
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = node.href; // absolute — the popup's base URL is about:blank
    return link;
  }
  if (node instanceof HTMLStyleElement) return node.cloneNode(true);
  return null;
}

const THEME_ATTRS = ['data-theme', 'data-hud', 'class', 'lang', 'dir'];

function mirrorRootAttrs(target: HTMLElement) {
  for (const attr of THEME_ATTRS) {
    const v = document.documentElement.getAttribute(attr);
    if (v === null) target.removeAttribute(attr);
    else target.setAttribute(attr, v);
  }
}

export interface PopoutPortalProps {
  id: string;
  title: string;
  /** Called when the popup is closed by the user (or was blocked). */
  onClosed: () => void;
  children: ReactNode;
}

export function PopoutPortal({ id, title, onClosed, children }: PopoutPortalProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;

  useEffect(() => {
    const timer = pendingClose.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      pendingClose.delete(id);
    }
    let win = popups.get(id);
    if (!win || win.closed) {
      // Opened outside a click (e.g. a restored state) — try once, else dock back.
      if (!openPanelPopout(id, { w: 480, h: 640 })) {
        onClosedRef.current();
        return undefined;
      }
      win = popups.get(id)!;
    }
    const doc = win.document;
    doc.title = `${title} · ShadowBroker`;
    mirrorRootAttrs(doc.documentElement);
    doc.head.replaceChildren();
    const meta = doc.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    doc.head.appendChild(meta);
    document.head.querySelectorAll('link[rel="stylesheet"], style').forEach((n) => {
      const c = cloneStyleNode(n, doc);
      if (c) doc.head.appendChild(c);
    });
    doc.body.replaceChildren();
    doc.body.style.margin = '0';
    doc.body.style.background = '#05090d';
    const root = doc.createElement('div');
    root.className = 'hud-zone font-mono';
    root.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;overflow:auto;';
    doc.body.appendChild(root);
    setContainer(root);

    const headObserver = new MutationObserver((records) => {
      for (const r of records) {
        r.addedNodes.forEach((n) => {
          if (n instanceof Element) {
            const c = cloneStyleNode(n, doc);
            if (c) doc.head.appendChild(c);
          }
        });
      }
    });
    headObserver.observe(document.head, { childList: true });
    const rootObserver = new MutationObserver(() => mirrorRootAttrs(doc.documentElement));
    rootObserver.observe(document.documentElement, { attributes: true, attributeFilter: THEME_ATTRS });

    const popup = win;
    const handleGone = () => {
      if (popups.get(id) === popup) popups.delete(id);
      onClosedRef.current();
    };
    popup.addEventListener('pagehide', handleGone);
    // pagehide is not guaranteed for every way a popup can die; poll as backstop.
    const poll = window.setInterval(() => {
      if (popup.closed) handleGone();
    }, 1000);

    return () => {
      headObserver.disconnect();
      rootObserver.disconnect();
      window.clearInterval(poll);
      popup.removeEventListener('pagehide', handleGone);
      setContainer(null);
      // Deferred so a StrictMode remount / re-render can adopt the same window.
      pendingClose.set(
        id,
        window.setTimeout(() => {
          pendingClose.delete(id);
          if (popups.get(id) === popup) popups.delete(id);
          if (!popup.closed) popup.close();
        }, 60),
      );
    };
  }, [id, title]);

  return container ? createPortal(children, container) : null;
}
