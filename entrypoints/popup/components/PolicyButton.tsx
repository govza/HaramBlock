import { useCallback, useMemo } from 'react';

import { EYE_AUTO_PATH, EYE_BLOCKED_PATH, EYE_VISIBLE_PATH } from '@/components/ui/icons';
import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { t } from '@/utils/i18n';

export const PolicyButton = () => {
  const { hostSettings, hostSettingsRepository } = useHostDataContext();

  const togglePolicy = useCallback(() => {
    void hostSettingsRepository.togglePolicy(hostSettings.hostname);
  }, [hostSettingsRepository, hostSettings.hostname]);

  const config = useMemo(() => {
    switch (hostSettings.policy) {
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
  }, [hostSettings.policy]);

  return (
    <div className='mb-2'>
      <button
        onClick={togglePolicy}
        className={`flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg p-2 transition-colors ${config.bgColor}`}
        aria-label={`${t('HostSettings.Policy.title')}: ${config.label}`}
      >
        <svg className='h-6 w-6' viewBox='0 0 24 24'>
          <title>{config.label}</title>
          <path fill='white' d={config.icon} />
        </svg>
        <span className='font-medium'>{config.label}</span>
      </button>
    </div>
  );
};
