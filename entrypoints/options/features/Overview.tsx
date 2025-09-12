import { LoadingSpinner } from '@/entrypoints/options/components/LoadingSpinner';
import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { t } from '@/utils/i18n';
import { logger } from '@/utils/logger';

export const Overview = () => {
  const { hostSettings, hostSettingsRepository, imageCacheRepository, isLoading } = useHostDataContext();

  const isStrictnessDisabled = hostSettings.policy !== 'process';

  const handlePolicyChange = async (newPolicy: 'whitelist' | 'blacklist' | 'process') => {
    try {
      await hostSettingsRepository.setPolicy(hostSettings.hostname, newPolicy);
    } catch (error) {
      logger.withTag('Overview').error('Failed to update policy:', error);
    }
  };

  const handleStrictnessChange = async (newStrictness: number) => {
    try {
      await hostSettingsRepository.setStrictness(hostSettings.hostname, newStrictness);
      await imageCacheRepository.deleteByHostname(hostSettings.hostname);
    } catch (error) {
      logger.withTag('Overview').error('Failed to update strictness:', error);
    }
  };

  if (isLoading) {
    return <LoadingSpinner />;
  }

  return (
    <div className='space-y-6'>
      <div className='border-b border-border-primary pb-4'>
        <h2 className='text-2xl font-bold text-text-primary mb-2'>{t('HostSettings.global')}</h2>
        <p className='text-text-muted text-base'>{t('HostSettings.description')}</p>
      </div>

      <div className='space-y-4'>
        <div className='bg-secondary p-4 rounded-lg transition-all duration-200 hover:bg-surface hover:shadow-lg'>
          <h3 className='text-lg font-semibold text-text-primary mb-2'>{t('HostSettings.Policy.title')}</h3>
          <p className='text-text-body text-base mb-3'>{t('HostSettings.Policy.description')}</p>
          <select
            value={hostSettings.policy}
            onChange={e => void handlePolicyChange(e.target.value as 'whitelist' | 'blacklist' | 'process')}
            className='w-full bg-surface border border-border-secondary text-text-secondary text-base rounded-lg p-2 accent-accent transition-colors duration-150 hover:bg-surface-light'
          >
            <option value='process'>{t('HostSettings.Policy.process')}</option>
            <option value='whitelist'>{t('HostSettings.Policy.whitelist')}</option>
            <option value='blacklist'>{t('HostSettings.Policy.blacklist')}</option>
          </select>
        </div>

        <div className='bg-secondary p-4 rounded-lg transition-all duration-200 hover:bg-surface hover:shadow-lg'>
          <h3 className='text-lg font-semibold text-text-primary mb-2'>{t('HostSettings.Strictness.title')}</h3>
          <div className='flex items-center space-x-4'>
            <div className='flex items-center space-x-2'>
              <span className={`text-sm ${isStrictnessDisabled ? 'text-text-disabled' : 'text-text-muted'}`}>
                {t('HostSettings.Strictness.permissive')}
              </span>
              <input
                type='range'
                min='0'
                max='1'
                step='0.01'
                value={hostSettings.strictness}
                onChange={e => void handleStrictnessChange(parseFloat(e.target.value))}
                disabled={isStrictnessDisabled}
                className={`w-128 accent-accent ${isStrictnessDisabled ? 'cursor-not-allowed opacity-50' : ''}`}
              />
              <span className={`text-sm ${isStrictnessDisabled ? 'text-text-disabled' : 'text-text-muted'}`}>
                {t('HostSettings.Strictness.strict')}
              </span>
            </div>
            <div className='flex items-center space-x-2'>
              <input
                type='number'
                min='0'
                max='100'
                value={Math.round(hostSettings.strictness * 100)}
                onChange={e => void handleStrictnessChange((parseInt(e.target.value) || 0) / 100)}
                disabled={isStrictnessDisabled}
                className={`w-16 bg-surface border border-border-secondary text-text-secondary text-sm rounded px-2 py-1 ${isStrictnessDisabled ? 'cursor-not-allowed opacity-50' : ''}`}
              />
              <span className={`text-sm ${isStrictnessDisabled ? 'text-text-disabled' : 'text-text-muted'}`}>%</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
