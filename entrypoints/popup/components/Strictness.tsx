import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { t } from '@/utils/i18n';

export const Strictness = () => {
  const { hostSettings, hostSettingsRepository, predictionCacheRepository } = useHostDataContext();

  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(event.target.value);
    await hostSettingsRepository.setStrictness(hostSettings.hostname, value);
    await predictionCacheRepository.deleteByHostname(hostSettings.hostname);
  };

  return (
    <div className='my-2 flex flex-col text-sm'>
      <label htmlFor='strictness-slider '>
        {t('strictness')} {`${(hostSettings.strictness * 100).toFixed()} %`}
      </label>
      <input
        id='strictness-slider'
        type='range'
        min='0'
        max='1'
        step='0.01'
        value={hostSettings.strictness}
        onChange={e => {
          void handleChange(e);
        }}
        className='w-full accent-blue-500 md:w-1/2'
      />
    </div>
  );
};
