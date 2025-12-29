import { useCallback } from 'react';

import { EYE_AUTO_PATH, EYE_BLOCKED_PATH, EYE_VISIBLE_PATH } from '@/components/ui/icons';
import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { DEFAULT_GLOBAL_KEY } from '@/utils/constants';
import { t } from '@/utils/i18n';

export const Header = () => {
  const { hostSettings, hostSettingsRepository } = useHostDataContext();
  const isGlobalSettings = hostSettings.hostname === DEFAULT_GLOBAL_KEY;

  const togglePolicy = useCallback(() => {
    void hostSettingsRepository.togglePolicy(hostSettings.hostname);
  }, [hostSettingsRepository, hostSettings.hostname]);

  const renderSvgPath = () => {
    switch (hostSettings.policy) {
      case 'whitelist':
        return (
          <>
            <title>{t('HostSettings.Policy.whitelist')}</title>
            <path fill='white' d={EYE_VISIBLE_PATH} />
          </>
        );
      case 'blacklist':
        return (
          <>
            <title>{t('HostSettings.Policy.blacklist')}</title>
            <path fill='red' d={EYE_BLOCKED_PATH} />
          </>
        );
      default:
        return (
          <>
            <title>{t('HostSettings.Policy.process')}</title>
            <path fill='green' d={EYE_AUTO_PATH} />
          </>
        );
    }
  };

  return (
    <div className={`flex w-full items-center p-2 ${isGlobalSettings ? 'bg-danger-bg' : 'bg-secondary'}`}>
      <p className='w-full truncate text-center text-lg'>
        {isGlobalSettings ? t(DEFAULT_GLOBAL_KEY) : hostSettings.hostname}
      </p>
      <button onClick={togglePolicy} className='cursor-pointer'>
        <svg className='inline-block h-[2em] w-auto fill-current px-1' viewBox='0 0 24 24'>
          {renderSvgPath()}
        </svg>
      </button>
    </div>
  );
};
