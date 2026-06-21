import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { t } from '@/utils/i18n';

import type { PolicyTarget } from '@/utils/types';

interface TargetChipProps {
  label: string;
  enabled: boolean;
  locked: boolean;
  onToggle: () => void;
  testId?: string;
}

const TargetChip = ({ label, enabled, locked, onToggle, testId }: TargetChipProps) => (
  <button
    type='button'
    className={`flex-1 rounded-md px-2.5 py-0.5 text-center text-xs font-medium transition-colors ${
      locked ? 'cursor-default' : 'cursor-pointer'
    } ${enabled ? 'bg-success text-white' : 'bg-text-muted text-text-inverse hover:bg-surface-light'}`}
    onClick={onToggle}
    data-testid={testId}
    aria-pressed={enabled}
  >
    {label}
  </button>
);

export const PolicyTargetSwitcher = () => {
  const { hostSettings, hostSettingsRepository, markDirty } = useHostDataContext();

  if (hostSettings.policy.behavior !== 'process') return null;

  const { targets } = hostSettings.policy;
  const enabledCount = Object.values(targets).filter(Boolean).length;

  const toggle = (target: PolicyTarget, enabled: boolean) => () => {
    // Keep at least one target enabled while processing — all-off would filter nothing.
    if (enabled && enabledCount === 1) return;
    void hostSettingsRepository.setTarget(hostSettings.hostname, target, !enabled).then(markDirty);
  };

  return (
    <div className='my-2 flex gap-2'>
      {(Object.keys(targets) as PolicyTarget[]).map(target => {
        const enabled = targets[target];
        return (
          <TargetChip
            key={target}
            label={t(`HostSettings.Targets.${target}`)}
            enabled={enabled}
            locked={enabled && enabledCount === 1}
            onToggle={toggle(target, enabled)}
            testId={`target-${target}`}
          />
        );
      })}
    </div>
  );
};
