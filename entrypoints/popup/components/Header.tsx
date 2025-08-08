import { useCallback } from 'react';

import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { defaultGlobalKey } from '@/utils/db/constants';
import { t } from '@/utils/i18n';

export const Header = () => {
  const { hostSettings, hostSettingsRepository } = useHostDataContext();
  const isGlobalSettings = hostSettings.hostname === defaultGlobalKey;

  const togglePolicy = useCallback(() => {
    void hostSettingsRepository.togglePolicy(hostSettings.hostname);
  }, [hostSettingsRepository, hostSettings.hostname]);

  const renderSvgPath = () => {
    switch (hostSettings.policy) {
      case 'whitelist':
        return (
          <>
            <title>{t('HostSettings.Policy.whitelist')}</title>
            <path
              fill='white'
              d='M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17M12,4.5C7,4.5 2.73,7.61 1,12C2.73,16.39 7,19.5 12,19.5C17,19.5 21.27,16.39 23,12C21.27,7.61 17,4.5 12,4.5Z'
            />
          </>
        );
      case 'blacklist':
        return (
          <>
            <title>{t('HostSettings.Policy.blacklist')}</title>
            <path
              fill='red'
              d='M11.83,9L15,12.16C15,12.11 15,12.05 15,12A3,3 0 0,0 12,9C11.94,9 11.89,9 11.83,9M7.53,9.8L9.08,11.35C9.03,11.56 9,11.77 9,12A3,3 0 0,0 12,15C12.22,15 12.44,14.97 12.65,14.92L14.2,16.47C13.53,16.8 12.79,17 12,17A5,5 0 0,1 7,12C7,11.21 7.2,10.47 7.53,9.8M2,4.27L4.28,6.55L4.73,7C3.08,8.3 1.78,10 1,12C2.73,16.39 7,19.5 12,19.5C13.55,19.5 15.03,19.2 16.38,18.66L16.81,19.08L19.73,22L21,20.73L3.27,3M12,7A5,5 0 0,1 17,12C17,12.64 16.87,13.26 16.64,13.82L19.57,16.75C21.07,15.5 22.27,13.86 23,12C21.27,7.61 17,4.5 12,4.5C10.6,4.5 9.26,4.75 8,5.2L10.17,7.35C10.74,7.13 11.35,7 12,7Z'
            />
          </>
        );
      default:
        return (
          <>
            <title>{t('HostSettings.Policy.process')}</title>
            <path
              fill='green'
              d='M23.5,17L18.5,22L15,18.5L16.5,17L18.5,19L22,15.5L23.5,17M12,9A3,3 0 0,1 15,12A3,3 0 0,1 12,15A3,3 0 0,1 9,12A3,3 0 0,1 12,9M12,17C12.5,17 12.97,16.93 13.42,16.79C13.15,17.5 13,18.22 13,19V19.45L12,19.5C7,19.5 2.73,16.39 1,12C2.73,7.61 7,4.5 12,4.5C17,4.5 21.27,7.61 23,12C22.75,12.64 22.44,13.26 22.08,13.85C21.18,13.31 20.12,13 19,13C18.22,13 17.5,13.15 16.79,13.42C16.93,12.97 17,12.5 17,12A5,5 0 0,0 12,7A5,5 0 0,0 7,12A5,5 0 0,0 12,17Z'
            />
          </>
        );
    }
  };

  return (
    <div className={`flex w-full items-center p-2 ${isGlobalSettings ? 'bg-danger-bg' : 'bg-secondary'}`}>
      <p className='w-full truncate text-center text-lg'>
        {isGlobalSettings ? t(defaultGlobalKey) : hostSettings.hostname}
      </p>
      <button onClick={togglePolicy} className='cursor-pointer'>
        <svg className='inline-block h-[2em] w-auto fill-current px-1' viewBox='0 0 24 24'>
          {renderSvgPath()}
        </svg>
      </button>
    </div>
  );
};
