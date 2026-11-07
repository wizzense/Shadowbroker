'use client';

/**
 * Digital Twin Town map layers and popup bodies.
 *
 * Venues: a circle sized by `twins_here`, dimmed when closed, with a pulsing
 * halo while twins are meeting there this hour. Town news: one pin at the area
 * centroid whose popup lists the happenings. Every string drawn here was
 * already passed through `sanitizeTwinTown`; React escapes it again on render.
 */

import React, { useEffect, useState } from 'react';
import { Layer, Source } from 'react-map-gl/maplibre';
import type { ExpressionSpecification } from 'maplibre-gl';
import { TWIN_SYNTHETIC_NOTE, twinLink, twinText, type TwinNewsItem } from '@/lib/twinTown';
import type { TwinTownState } from '@/components/map/hooks/useTwinTown';

export const TWIN_VENUE_LAYER_ID = 'twin-town-venues-layer';
export const TWIN_NEWS_LAYER_ID = 'twin-town-news-layer';
const VENUE_ACCENT = '#c084fc';
const NEWS_ACCENT = '#facc15';
const PULSE_FRAME_MS = 125;

export type TwinTownVisibility = { venues: boolean; news: boolean };

/** Interactive (clickable) layer ids for what is currently drawn. */
export function twinTownInteractiveIds(state: TwinTownState, show: TwinTownVisibility): string[] {
  const ids: string[] = [];
  if (show.venues && state.data?.venues.features.length) ids.push(TWIN_VENUE_LAYER_ID);
  if (show.news && state.data?.newsPin.features.length) ids.push(TWIN_NEWS_LAYER_ID);
  return ids;
}

/** 0..1..0 every ~1.5 s while something is pulsing; constant otherwise. */
function usePulse(active: boolean): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    const id = setInterval(() => setT(((Date.now() - started) % 1500) / 1500), PULSE_FRAME_MS);
    return () => clearInterval(id);
  }, [active]);
  return active ? Math.sin(t * Math.PI) : 0;
}

export default function TwinTownLayers({ state, show }: { state: TwinTownState; show: TwinTownVisibility }) {
  const venues = show.venues ? state.data?.venues : null;
  const newsPin = show.news ? state.data?.newsPin : null;
  const pulsing = !!venues?.features.some((f) => Number(f.properties?.meetings_hour) > 0);
  const pulse = usePulse(pulsing);
  const radius: ExpressionSpecification = ['interpolate', ['linear'], ['get', 'twins_here'], 0, 4, 10, 7, 50, 11, 200, 16];
  return (
    <>
      {venues && venues.features.length > 0 && (
        <Source id="twin-town-venues-source" type="geojson" data={venues}>
          <Layer
            id="twin-town-venues-pulse"
            type="circle"
            filter={['>', ['get', 'meetings_hour'], 0]}
            paint={{
              'circle-color': VENUE_ACCENT,
              'circle-radius': ['+', radius, 4 + pulse * 8],
              'circle-opacity': 0.35 * (1 - pulse * 0.8),
            }}
          />
          <Layer
            id={TWIN_VENUE_LAYER_ID}
            type="circle"
            paint={{
              'circle-color': VENUE_ACCENT,
              'circle-radius': radius,
              'circle-opacity': ['case', ['get', 'open'], 0.9, 0.3],
              'circle-stroke-width': 1,
              'circle-stroke-color': ['case', ['get', 'open'], 'rgba(0,0,0,0.7)', 'rgba(0,0,0,0.3)'],
            }}
          />
          <Layer
            id="twin-town-venues-label"
            type="symbol"
            minzoom={13}
            layout={{
              'text-field': ['get', 'name'],
              'text-font': ['Noto Sans Regular'],
              'text-size': 10,
              'text-offset': [0, 1.2],
              'text-anchor': 'top',
              'text-allow-overlap': false,
            }}
            paint={{ 'text-color': '#e9d5ff', 'text-halo-color': 'rgba(0,0,0,0.9)', 'text-halo-width': 1 }}
          />
        </Source>
      )}
      {newsPin && newsPin.features.length > 0 && (
        <Source id="twin-town-news-source" type="geojson" data={newsPin}>
          <Layer
            id={TWIN_NEWS_LAYER_ID}
            type="circle"
            paint={{
              'circle-color': NEWS_ACCENT,
              'circle-radius': 8,
              'circle-opacity': 0.95,
              'circle-stroke-width': 2,
              'circle-stroke-color': '#422006',
            }}
          />
        </Source>
      )}
    </>
  );
}

// ─── Popup bodies (rendered inside the viewer's <Popup>) ────────────────────

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** MapLibre hands back feature properties; booleans may arrive as strings. */
export function TwinVenuePopupBody({ props, onClose }: { props: Record<string, unknown>; onClose?: () => void }) {
  const open = props.open === true || props.open === 'true';
  const twins = num(props.twins_here);
  const meetings = num(props.meetings_hour);
  return (
    <div
      data-testid="twin-venue-popup"
      className="map-popup bg-[#0b0f14] text-[#e5e7eb] min-w-[200px]"
      style={{ border: `1px solid ${VENUE_ACCENT}66` }}
    >
      <div className="flex items-start gap-2 border-b pb-1" style={{ borderColor: `${VENUE_ACCENT}33` }}>
        <div className="map-popup-title" style={{ color: VENUE_ACCENT }}>
          {twinText(props.name, 80) || 'Unnamed venue'}
        </div>
        {onClose && (
          <button onClick={onClose} className="ml-auto text-[var(--text-secondary)] hover:text-[var(--text-primary)] shrink-0">
            ✕
          </button>
        )}
      </div>
      {twinText(props.kind, 40) && (
        <div className="map-popup-row">
          Kind: <span className="text-white">{twinText(props.kind, 40)}</span>
        </div>
      )}
      <div className="map-popup-row">
        {twins} {twins === 1 ? 'twin' : 'twins'} here this hour
      </div>
      <div className="map-popup-row">
        {meetings} {meetings === 1 ? 'meeting' : 'meetings'}
      </div>
      {!open && <div className="map-popup-row text-[var(--text-secondary)]">Closed now</div>}
      <div className="mt-1.5 text-[9px] tracking-wider" style={{ color: `${VENUE_ACCENT}aa` }}>
        DIGITAL TWIN TOWN · {TWIN_SYNTHETIC_NOTE}
      </div>
    </div>
  );
}

export function TwinNewsList({ items, onClose }: { items: TwinNewsItem[]; onClose?: () => void }) {
  return (
    <div
      data-testid="twin-news-popup"
      className="map-popup bg-[#0b0f14] text-[#e5e7eb] min-w-[220px]"
      style={{ border: `1px solid ${NEWS_ACCENT}66` }}
    >
      <div className="flex items-start gap-2 border-b pb-1" style={{ borderColor: `${NEWS_ACCENT}33` }}>
        <div className="map-popup-title" style={{ color: NEWS_ACCENT }}>
          Town news
        </div>
        {onClose && (
          <button onClick={onClose} className="ml-auto text-[var(--text-secondary)] hover:text-[var(--text-primary)] shrink-0">
            ✕
          </button>
        )}
      </div>
      {items.length === 0 && <div className="map-popup-row text-[var(--text-secondary)]">No happenings for this area.</div>}
      <ul className="mt-1 max-h-[220px] overflow-y-auto styled-scrollbar">
        {items.map((n, i) => {
          const title = twinText(n.title);
          const link = twinLink(n.link);
          const meta = [twinText(n.source, 80), twinText(n.published_at, 40)].filter(Boolean).join(' · ');
          return (
            <li key={i} className="text-[10px] py-0.5 border-b border-white/5">
              {link ? (
                <a href={link} target="_blank" rel="noopener noreferrer" className="underline text-white">
                  {title}
                </a>
              ) : (
                <span className="text-white">{title}</span>
              )}
              {meta && <div className="text-[var(--text-secondary)]">{meta}</div>}
            </li>
          );
        })}
      </ul>
      <div className="mt-1.5 text-[9px] tracking-wider" style={{ color: `${NEWS_ACCENT}aa` }}>
        WHAT THE TWINS ARE REACTING TO · DIGITAL TWIN TOWN
      </div>
    </div>
  );
}
