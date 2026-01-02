import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { t } from '@/utils/i18n';

export const PixelationScale = () => {
  const { hostSettings, hostSettingsRepository } = useHostDataContext();

  const isHidden = hostSettings.policy !== 'process' || hostSettings.outline !== 'segment';

  if (isHidden) return null;

  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(event.target.value, 10);
    await hostSettingsRepository.setPixelationScale(hostSettings.hostname, value);
  };

  return (
    <div className='my-2 flex flex-col text-sm'>
      <label htmlFor='pixelation-scale-slider' className='text-text-muted'>
        {t('HostSettings.Masking.PixelationScale.title')} {`${hostSettings.masking.pixelationScale}%`}
      </label>
      <input
        id='pixelation-scale-slider'
        type='range'
        min='1'
        max='100'
        step='1'
        value={hostSettings.masking.pixelationScale}
        onChange={e => {
          void handleChange(e);
        }}
        className='w-full accent-accent'
      />
    </div>
  );
};
