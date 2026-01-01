import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { t } from '@/utils/i18n';

export const BlurTint = () => {
  const { hostSettings, hostSettingsRepository } = useHostDataContext();

  const isDisabled = hostSettings.policy !== 'process';

  const handleGrayscaleToggle = () => {
    if (isDisabled) return;
    void hostSettingsRepository.setGrayscale(hostSettings.hostname, !hostSettings.masking.grayscale);
  };

  const handleDarkToggle = () => {
    if (isDisabled) return;
    void hostSettingsRepository.setDark(hostSettings.hostname, !hostSettings.masking.dark);
  };

  return (
    <div className='my-2 flex flex-col gap-1 text-sm'>
      <label className='text-text-muted'>{t('HostSettings.Masking.BlurTint.title')}</label>
      <div className='flex flex-1 gap-2'>
        <div className='flex flex-1 rounded-full bg-text-muted p-1 transition'>
          <button
            className={`flex-1 rounded-full p-1 text-center transition-all duration-200 ${isDisabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-surface-light'} ${
              hostSettings.masking.grayscale
                ? 'bg-surface text-white shadow-lg ring-2 ring-accent-light ring-opacity-50'
                : 'text-text-inverse hover:text-text-inverse'
            }`}
            onClick={handleGrayscaleToggle}
            disabled={isDisabled}
            style={{ opacity: isDisabled ? 0.5 : 1 }}
          >
            {t('HostSettings.Masking.BlurTint.grayscale')}
          </button>
        </div>
        <div className='flex flex-1 rounded-full bg-text-muted p-1 transition'>
          <button
            className={`flex-1 rounded-full p-1 text-center transition-all duration-200 ${isDisabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-surface-light'} ${
              hostSettings.masking.dark
                ? 'bg-surface text-white shadow-lg ring-2 ring-accent-light ring-opacity-50'
                : 'text-text-inverse hover:text-text-inverse'
            }`}
            onClick={handleDarkToggle}
            disabled={isDisabled}
            style={{ opacity: isDisabled ? 0.5 : 1 }}
          >
            {t('HostSettings.Masking.BlurTint.dark')}
          </button>
        </div>
      </div>
    </div>
  );
};
