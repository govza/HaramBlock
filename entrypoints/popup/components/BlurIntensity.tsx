import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { t } from '@/utils/i18n';

export const BlurIntensity = () => {
  const { hostSettings, hostSettingsRepository, markDirty } = useHostDataContext();

  // Show for blacklist (always) or process mode with bbox outline
  const isHidden =
    hostSettings.policy !== 'blacklist' && (hostSettings.policy !== 'process' || hostSettings.outline !== 'bbox');

  if (isHidden) return null;

  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(event.target.value, 10);
    await hostSettingsRepository.setBlurIntensity(hostSettings.hostname, value);
    markDirty();
  };

  return (
    <div className='my-2 flex flex-col text-sm'>
      <label htmlFor='blur-intensity-slider' className='text-text-muted'>
        {t('HostSettings.Masking.BlurIntensity.title')} {`${hostSettings.masking.blurIntensity}%`}
      </label>
      <input
        id='blur-intensity-slider'
        type='range'
        min='1'
        max='100'
        step='1'
        value={hostSettings.masking.blurIntensity}
        onChange={e => {
          void handleChange(e);
        }}
        className='w-full accent-accent'
      />
    </div>
  );
};
