'use client';

/**
 * "<town> · <N> synthetic twins · as of <time>" — which twin town the Digital
 * Twin Town layer is showing, plus the standing note that its residents are
 * simulated. While the upstream prepares a new area it says so instead.
 */

import React, { useEffect, useState } from 'react';
import {
  getTwinTownStatus,
  TWIN_SYNTHETIC_NOTE,
  TWIN_TOWN_STATUS_EVENT,
  TWIN_WARMING_MESSAGE,
  twinTownChipText,
  type TwinTownStatus,
} from '@/lib/twinTown';

export function useTwinTownStatus(): TwinTownStatus {
  const [value, setValue] = useState<TwinTownStatus>(getTwinTownStatus);
  useEffect(() => {
    const sync = () => setValue(getTwinTownStatus());
    sync();
    window.addEventListener(TWIN_TOWN_STATUS_EVENT, sync);
    return () => window.removeEventListener(TWIN_TOWN_STATUS_EVENT, sync);
  }, []);
  return value;
}

export function TwinTownChipView({ status }: { status: TwinTownStatus }) {
  if (status.phase === 'off') return null;
  let line: string;
  if (status.phase === 'warming') line = TWIN_WARMING_MESSAGE;
  else if (status.phase === 'loading') line = 'Twin town loading…';
  else if (status.phase === 'unavailable') line = status.message;
  else line = status.town ? twinTownChipText(status.town) : 'Twin town';
  return (
    <div
      data-testid="twin-town-chip"
      className="mx-1 mb-2 border border-fuchsia-700/40 bg-fuchsia-950/20 px-2 py-1 text-[10px] font-mono leading-snug text-fuchsia-300"
    >
      <div>{line}</div>
      <div className="text-fuchsia-400/70">{TWIN_SYNTHETIC_NOTE}</div>
    </div>
  );
}

export default function TwinTownChip() {
  return <TwinTownChipView status={useTwinTownStatus()} />;
}
