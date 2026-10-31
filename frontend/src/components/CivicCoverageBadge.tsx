'use client';

/**
 * "civic coverage: <area>" — which area the civic point layers and district
 * lines are loaded for. Zoomed in that is one 50 km circle; zoomed out it is
 * the states in view (capped). Without it an empty map reads as "no data"
 * when it really means "not this area".
 */

import React, { useEffect, useState } from 'react';
import { CIVIC_COVERAGE_EVENT, getCivicCoverage, type CivicCoverage } from '@/lib/civicLayers';

export function useCivicCoverage(): CivicCoverage {
  const [value, setValue] = useState<CivicCoverage>(getCivicCoverage);
  useEffect(() => {
    const sync = () => setValue(getCivicCoverage());
    sync();
    window.addEventListener(CIVIC_COVERAGE_EVENT, sync);
    return () => window.removeEventListener(CIVIC_COVERAGE_EVENT, sync);
  }, []);
  return value;
}

export default function CivicCoverageBadge() {
  const { points, boundaries } = useCivicCoverage();
  if (!points && !boundaries) return null;
  return (
    <div
      data-testid="civic-coverage-badge"
      className="mx-1 mb-2 border border-violet-700/40 bg-violet-950/20 px-2 py-1 text-[10px] font-mono leading-snug text-violet-300"
    >
      {points && <div>civic coverage: {points}</div>}
      {boundaries && <div>district lines: {boundaries}</div>}
    </div>
  );
}
