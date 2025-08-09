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
      <div
        className={`flex flex-1 rounded-full bg-gray-400 p-1 transition ${
          hostSettings.outline === 'full' ? 'opacity-50' : ''
        }`}
      >
        <button
          className={`flex-1 rounded-full p-1 text-center transition-all duration-200 ${isDisabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-gray-500'} ${
            hostSettings.outline === 'bbox'
              ? 'bg-gray-600 text-white shadow-lg ring-2 ring-blue-400 ring-opacity-50'
              : 'text-gray-800 hover:text-gray-700'
          }`}
          onClick={() => handleChange('bbox')}
          disabled={isDisabled}
          style={{ opacity: isDisabled ? 0.5 : 1 }}
        >
          {t('HostSettings.Outline.boundingBox')}
        </button>
        <button
          className={`flex-1 rounded-full p-1 text-center transition-all duration-200 ${isDisabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-gray-500'} ${
            hostSettings.outline === 'segment'
              ? 'bg-gray-600 text-white shadow-lg ring-2 ring-blue-400 ring-opacity-50'
              : 'text-gray-800 hover:text-gray-700'
          }`}
          onClick={() => handleChange('segment')}
          disabled={isDisabled}
          style={{ opacity: isDisabled ? 0.5 : 1 }}
        >
          {t('HostSettings.Outline.segment')}
        </button>
      </div>
      <div
        className={`w-9 h-9 rounded-full transition p-1 ${
          hostSettings.outline === 'full' ? 'bg-gray-400 ring-2 ring-inset ring-gray-400' : 'bg-gray-400'
        }`}
      >
        <button
          className={`w-full h-full rounded-full ${isDisabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-gray-500'} flex items-center justify-center transition-all duration-200 ${
            hostSettings.outline === 'full'
              ? 'bg-gray-600 text-white shadow-lg ring-2 ring-blue-400 ring-opacity-50'
              : 'text-gray-700 hover:text-gray-600'
          }`}
          onClick={() => handleChange('full')}
          disabled={isDisabled}
          style={{ opacity: isDisabled ? 0.5 : 1 }}
        >
          <svg
            xmlns='http://www.w3.org/2000/svg'
            fill='none'
            viewBox='0 0 24 24'
            strokeWidth={1.5}
            stroke='currentColor'
            className='size-6'
          >
            <path strokeLinecap='round' d='M15 12H9m12 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z' />
          </svg>
        </button>
      </div>
    </div>
  );
};
