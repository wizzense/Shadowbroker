import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TwinNewsList, TwinVenuePopupBody } from '@/components/map/TwinTownLayers';
import { TwinTownChipView } from '@/components/TwinTownChip';
import { TWIN_SYNTHETIC_NOTE, TWIN_WARMING_MESSAGE } from '@/lib/twinTown';

afterEach(cleanup);

describe('twin town popups and chip', () => {
  it('venue popup shows name, kind, twins and meetings as plain text', () => {
    const { getByTestId, container } = render(
      <TwinVenuePopupBody
        props={{
          name: '<img src=x onerror="alert(1)">Corner Cafe',
          kind: 'cafe',
          open: 'false',
          twins_here: 7,
          meetings_hour: 2,
        }}
      />,
    );
    const text = getByTestId('twin-venue-popup').textContent ?? '';
    expect(text).toContain('Corner Cafe');
    expect(text).not.toContain('<img');
    expect(text).toContain('Kind: cafe');
    expect(text).toContain('7 twins here this hour');
    expect(text).toContain('2 meetings');
    expect(text).toContain('Closed now');
    expect(text).toContain(TWIN_SYNTHETIC_NOTE);
    expect(container.querySelector('img')).toBeNull();
  });

  it('news list escapes titles and opens only http(s) links in a new tab, noopener noreferrer', () => {
    const { getByTestId, container } = render(
      <TwinNewsList
        items={[
          {
            title: 'Council <script>alert(1)</script>votes',
            source: 'Paper',
            link: 'https://news.test/a',
            published_at: '2026-11-06',
          },
          { title: 'Bad link', source: '', link: 'javascript:alert(1)', published_at: '' },
        ]}
      />,
    );
    expect(container.querySelector('script')).toBeNull();
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://news.test/a');
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(getByTestId('twin-news-popup').textContent).toContain('Bad link');
  });

  it('chip names the town, counts synthetic twins, and always carries the synthetic note', () => {
    const town = {
      id: 't',
      name: 'Twinford',
      county_fips: '39061',
      residents: 1200,
      synthetic: true,
      as_of: 'noon',
      cache_age_s: 0,
    };
    const { getByTestId, rerender, container } = render(<TwinTownChipView status={{ phase: 'ready', town }} />);
    expect(getByTestId('twin-town-chip').textContent).toContain('Twinford · 1,200 synthetic twins · as of noon');
    expect(getByTestId('twin-town-chip').textContent).toContain(TWIN_SYNTHETIC_NOTE);
    rerender(<TwinTownChipView status={{ phase: 'warming' }} />);
    expect(getByTestId('twin-town-chip').textContent).toContain(TWIN_WARMING_MESSAGE);
    expect(getByTestId('twin-town-chip').textContent).toContain(TWIN_SYNTHETIC_NOTE);
    rerender(<TwinTownChipView status={{ phase: 'off' }} />);
    expect(container.textContent).toBe('');
  });
});
