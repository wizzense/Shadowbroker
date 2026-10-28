import { describe, it, expect } from 'vitest';
import { UPSTREAM_SOURCE_URL, sourceCodeAttributionHtml, sourceCodeUrl } from '@/lib/sourceLink';

describe('sourceCodeUrl (AGPL-3.0 §13 source link)', () => {
  it('defaults to the upstream repository', () => {
    expect(sourceCodeUrl(undefined)).toBe(UPSTREAM_SOURCE_URL);
    expect(sourceCodeUrl('  ')).toBe(UPSTREAM_SOURCE_URL);
  });

  it('uses the configured repository of a modified build', () => {
    expect(sourceCodeUrl('https://git.example.org/me/shadowbroker-fork')).toBe(
      'https://git.example.org/me/shadowbroker-fork',
    );
  });

  it('refuses non-http(s) and unparseable values', () => {
    expect(sourceCodeUrl('javascript:alert(1)')).toBe(UPSTREAM_SOURCE_URL);
    expect(sourceCodeUrl('not a url')).toBe(UPSTREAM_SOURCE_URL);
  });
});

describe('sourceCodeAttributionHtml', () => {
  it('links to the source in a new tab', () => {
    const html = sourceCodeAttributionHtml('https://git.example.org/me/fork');
    expect(html).toBe(
      '<a href="https://git.example.org/me/fork" target="_blank" rel="noopener">source code (AGPL-3.0)</a>',
    );
  });

  it('escapes the URL so it cannot break out of the attribute', () => {
    const html = sourceCodeAttributionHtml('https://x.example/"><img src=x onerror=alert(1)>');
    expect(html).not.toContain('"><img');
    expect(html).toContain('&quot;&gt;&lt;img');
  });
});
