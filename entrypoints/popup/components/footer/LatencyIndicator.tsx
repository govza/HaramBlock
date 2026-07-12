import { useEffect, useState } from 'react';

import { t } from '@/utils/i18n';
import { classifyLatency, type LatencyBand, type LatencySnapshot } from '@/utils/inference/shared/latencyTracker';
import { backgroundRpc } from '@/utils/messaging/popup';

const POLL_INTERVAL_MS = 2000;

// The bands share their thresholds with the auto model switcher (latencyTracker.ts), so a red box
// means exactly "auto mode would consider this model too slow here".
const bandColorClass: Record<LatencyBand, string> = {
  good: 'border-green-500 text-green-500',
  strained: 'border-yellow-500 text-yellow-500',
  overloaded: 'border-red-500 text-red-500',
};

export const LatencyIndicator = () => {
  const [snapshot, setSnapshot] = useState<LatencySnapshot | null>(null);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      try {
        const latency = await backgroundRpc.getInferenceLatency();
        if (active) setSnapshot(latency);
      } catch {
        if (active) setSnapshot(null);
      }
    };

    void poll();
    const intervalId = setInterval(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, []);

  const colorClass = snapshot ? bandColorClass[classifyLatency(snapshot.p75Ms)] : 'border-current text-gray-400';
  const label = snapshot ? `${Math.round(snapshot.p75Ms)}ms` : '—ms';
  const tooltip = snapshot
    ? t('LatencyIndicator.tooltip', [snapshot.modelId, snapshot.backend, String(snapshot.sampleCount)])
    : t('LatencyIndicator.noDataTooltip');

  return (
    <span className={`rounded border px-0.5 py-px text-[10px] font-mono ${colorClass}`} title={tooltip}>
      {label}
    </span>
  );
};
