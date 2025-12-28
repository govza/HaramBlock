import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { t } from '@/utils/i18n';

import type { OutlineType } from '@/utils/types';

export const Outline = () => {
  const { hostSettings, hostSettingsRepository } = useHostDataContext();

  const isDisabled = hostSettings.policy !== 'process';

  const handleChange = (outline: OutlineType) => {
    if (isDisabled) return;
    void hostSettingsRepository.setOutline(hostSettings.hostname, outline);
  };

  return (
    <div className='my-2 flex items-center gap-2 text-sm'>
      <div className='flex flex-1 rounded-full bg-text-muted p-1 transition'>
        <button
          className={`flex-1 rounded-full p-1 text-center transition-all duration-200 ${isDisabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-surface-light'} ${
            hostSettings.outline === 'bbox'
              ? 'bg-surface text-white shadow-lg ring-2 ring-accent-light ring-opacity-50'
              : 'text-text-inverse hover:text-text-inverse'
          }`}
          onClick={() => handleChange('bbox')}
          disabled={isDisabled}
          style={{ opacity: isDisabled ? 0.5 : 1 }}
        >
          {t('HostSettings.Outline.bbox')}
        </button>
        <button
          className={`flex-1 rounded-full p-1 text-center transition-all duration-200 ${isDisabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-surface-light'} ${
            hostSettings.outline === 'segment'
              ? 'bg-surface text-white shadow-lg ring-2 ring-accent-light ring-opacity-50'
              : 'text-text-inverse hover:text-text-inverse'
          }`}
          onClick={() => handleChange('segment')}
          disabled={isDisabled}
          style={{ opacity: isDisabled ? 0.5 : 1 }}
        >
          {t('HostSettings.Outline.segment')}
        </button>
      </div>
    </div>
  );
};
