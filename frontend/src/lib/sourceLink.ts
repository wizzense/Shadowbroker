/**
 * Where this deployment's source code lives.
 *
 * ShadowBroker is AGPL-3.0: a modified version served over a network must offer
 * its users the corresponding source (§13). Builds of a modified version set
 * NEXT_PUBLIC_SOURCE_URL to their own repository; unmodified builds link to the
 * upstream project.
 */
export const UPSTREAM_SOURCE_URL = 'https://github.com/BigBodyCobain/Shadowbroker';

export function sourceCodeUrl(raw: string | undefined = process.env.NEXT_PUBLIC_SOURCE_URL): string {
  const value = (raw || '').trim();
  if (!value) return UPSTREAM_SOURCE_URL;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : UPSTREAM_SOURCE_URL;
  } catch {
    return UPSTREAM_SOURCE_URL;
  }
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** The map attribution entry that links to the source (an escaped HTML string). */
export function sourceCodeAttributionHtml(url: string = sourceCodeUrl()): string {
  const href = url.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
  return `<a href="${href}" target="_blank" rel="noopener">source code (AGPL-3.0)</a>`;
}
