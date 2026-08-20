import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { useVideoProcessingAvailable } from '@/entrypoints/popup/hooks/useVideoProcessingAvailable';
import { t } from '@/utils/i18n';

import type { PolicyTarget } from '@/utils/types';

interface TargetChipProps {
  label: string;
  enabled: boolean;
  onToggle: () => void;
  testId?: string;
}

const TargetChip = ({ label, enabled, onToggle, testId }: TargetChipProps) => (
  <button
    type='button'
    className={`flex-1 cursor-pointer rounded-md px-2.5 py-0.5 text-center text-xs font-medium transition-colors ${
      enabled ? 'bg-success text-white' : 'bg-text-muted text-text-inverse hover:bg-surface-light'
    }`}
    onClick={onToggle}
    data-testid={testId}
    aria-pressed={enabled}
  >
    {label}
  </button>
);

export const PolicyTargetSwitcher = () => {
  const { hostSettings, hostSettingsRepository, markDirty } = useHostDataContext();
  const videoProcessingAvailable = useVideoProcessingAvailable();

  if (hostSettings.policy.behavior !== 'process') return null;

  const { targets } = hostSettings.policy;
  const enabledCount = Object.values(targets).filter(Boolean).length;

  const toggle = (target: PolicyTarget, enabled: boolean) => () => {
    // Disabling the last enabled target means no processing at all — whitelist the
    // host instead, keeping targets untouched so they restore on return to process.
    if (enabled && enabledCount === 1) {
      void hostSettingsRepository.setBehavior(hostSettings.hostname, 'whitelist').then(markDirty);
      return;
    }
    void hostSettingsRepository.setTarget(hostSettings.hostname, target, !enabled).then(markDirty);
  };

  return (
    <div className='my-2 flex gap-2'>
      {(Object.keys(targets) as PolicyTarget[])
        .filter(target => target !== 'video' || videoProcessingAvailable)
        .map(target => {
          const enabled = targets[target];
          return (
            <TargetChip
              key={target}
              label={t(`HostSettings.Targets.${target}`)}
              enabled={enabled}
              onToggle={toggle(target, enabled)}
              testId={`target-${target}`}
            />
          );
        })}
    </div>
  );
};
