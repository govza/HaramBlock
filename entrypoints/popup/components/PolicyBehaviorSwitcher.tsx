import { useCallback, useMemo } from 'react';

import { EYE_AUTO_PATH, EYE_BLOCKED_PATH, EYE_VISIBLE_PATH, REFRESH_PATH } from '@/components/ui/icons';
import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { t } from '@/utils/i18n';

export const PolicyBehaviorSwitcher = () => {
  const { hostSettings, hostSettingsRepository, isDirty, markDirty, reloadTab } = useHostDataContext();

  const togglePolicy = useCallback(() => {
    void hostSettingsRepository.togglePolicy(hostSettings.hostname).then(markDirty);
  }, [hostSettingsRepository, hostSettings.hostname, markDirty]);

  const config = useMemo(() => {
    switch (hostSettings.policy.behavior) {
      case 'whitelist':
        return {
          label: t('HostSettings.Policy.whitelist'),
          icon: EYE_VISIBLE_PATH,
          bgColor: 'bg-surface hover:bg-surface-light',
        };
      case 'blacklist':
        return {
          label: t('HostSettings.Policy.blacklist'),
          icon: EYE_BLOCKED_PATH,
          bgColor: 'bg-danger-dark hover:bg-danger',
        };
      default:
        return {
          label: t('HostSettings.Policy.process'),
          icon: EYE_AUTO_PATH,
          bgColor: 'bg-success-dark hover:bg-success',
        };
    }
  }, [hostSettings.policy.behavior]);

  return (
    <div className='mb-2 flex gap-2'>
      <button
        onClick={togglePolicy}
        className={`flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg p-2 transition-colors ${config.bgColor}`}
        aria-label={`${t('HostSettings.Policy.title')}: ${config.label}`}
        data-testid='policy-toggle'
        data-policy={hostSettings.policy.behavior}
      >
        <svg className='h-6 w-6 shrink-0' viewBox='0 0 24 24'>
          <title>{config.label}</title>
          <path fill='white' d={config.icon} />
        </svg>
        <span className='font-medium'>{config.label}</span>
      </button>
      {isDirty && (
        <button
          onClick={reloadTab}
          className='flex cursor-pointer items-center justify-center rounded-lg bg-accent px-3 transition-colors hover:bg-accent-light'
          data-testid='update-button'
        >
          <svg className='h-5 w-5' viewBox='0 0 24 24'>
            <path fill='white' d={REFRESH_PATH} />
          </svg>
        </button>
      )}
    </div>
  );
};
