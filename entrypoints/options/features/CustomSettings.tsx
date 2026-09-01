import { useState, useEffect } from 'react';

import { LoadingSpinner } from '@/entrypoints/options/components/LoadingSpinner';
import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { DEFAULT_GLOBAL_KEY } from '@/utils/constants';
import { t } from '@/utils/i18n';
import { getLogger } from '@/utils/telemetry';

import type { IHostSettings } from '@/utils/types';

const log = getLogger('CustomSettings');

export const CustomSettings = () => {
  const { hostSettingsRepository, isLoading } = useHostDataContext();
  const [allHosts, setAllHosts] = useState<IHostSettings[]>([]);
  const [globalSettings, setGlobalSettings] = useState<IHostSettings | null>(null);

  const getPolicyBadgeClass = (policy: string) => {
    if (policy === 'whitelist') {
      return 'bg-success-light/20 text-success border border-success-light/30';
    }
    if (policy === 'blacklist') {
      return 'bg-danger-light/20 text-danger border border-danger-light/30';
    }
    return 'bg-surface-light text-text-muted border border-border-secondary';
  };

  const isDifferentFromGlobal = (host: IHostSettings, field: keyof IHostSettings): boolean => {
    if (!globalSettings || host.hostname === DEFAULT_GLOBAL_KEY) return false;

    if (field === 'masking' || field === 'policy') {
      return JSON.stringify(host[field]) !== JSON.stringify(globalSettings[field]);
    }

    return host[field] !== globalSettings[field];
  };

  const getHighlightClass = (host: IHostSettings, field: keyof IHostSettings): string => {
    return isDifferentFromGlobal(host, field) ? 'bg-accent/20 shadow-sm' : '';
  };

  useEffect(() => {
    const loadHosts = async () => {
      if (!hostSettingsRepository) return;

      try {
        const hosts = await hostSettingsRepository.findAll();
        const globalHost = await hostSettingsRepository.findByHostname(DEFAULT_GLOBAL_KEY);

        // Sort so global settings always come first
        const sortedHosts = [...hosts].sort((a, b) => {
          if (a.hostname === DEFAULT_GLOBAL_KEY) return -1;
          if (b.hostname === DEFAULT_GLOBAL_KEY) return 1;
          return a.hostname.localeCompare(b.hostname);
        });

        setAllHosts(sortedHosts);
        setGlobalSettings(globalHost);
      } catch (error) {
        log.error('ui.hosts.load_failed', { error });
      }
    };

    void loadHosts();
  }, [hostSettingsRepository]);

  const handleRemoveHost = async (hostname: string) => {
    if (!hostSettingsRepository) return;

    try {
      await hostSettingsRepository.delete(hostname);

      if (hostname === DEFAULT_GLOBAL_KEY) {
        // If global settings were reset, fetch the updated global settings
        const updatedGlobalSettings = await hostSettingsRepository.findByHostname(DEFAULT_GLOBAL_KEY);
        setGlobalSettings(updatedGlobalSettings);

        // Update the hosts list to reflect the reset global settings
        setAllHosts(prev => prev.map(host => (host.hostname === DEFAULT_GLOBAL_KEY ? updatedGlobalSettings : host)));
      } else {
        setAllHosts(prev => prev.filter(host => host.hostname !== hostname));
      }
    } catch (error) {
      log.error('ui.host.remove_failed', { error });
    }
  };

  if (isLoading) {
    return <LoadingSpinner />;
  }

  return (
    <div className='space-y-6'>
      <div className='border-b border-border-primary pb-4'>
        <h2 className='text-2xl font-bold text-text-primary mb-2'>{t('HostSettings.customSettings')}</h2>
      </div>

      <div className='bg-secondary rounded-lg overflow-hidden'>
        {allHosts.length === 0 ? (
          <div className='p-8 text-center'>
            <p className='text-text-muted text-base'>{t('Common.noData')}</p>
          </div>
        ) : (
          <div className='overflow-x-auto'>
            <table className='w-full text-sm text-left'>
              <thead className='bg-surface border-b border-border-secondary text-center'>
                <tr className='divide-x divide-border-secondary'>
                  <th className='px-6 py-3 text-text-primary font-semibold'>{t('Common.hostname')}</th>
                  <th className='px-6 py-3 text-text-primary font-semibold'>{t('HostSettings.Policy.title')}</th>
                  <th className='px-6 py-3 text-text-primary font-semibold'>{t('HostSettings.Masking.title')}</th>
                  <th className='px-6 py-3 text-text-primary font-semibold'>{t('HostSettings.Strictness.title')}</th>
                  <th className='px-6 py-3 text-text-primary font-semibold'>{t('Common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {allHosts.map((host, index) => (
                  <tr
                    key={host.hostname}
                    className={`${index % 2 === 0 ? 'bg-secondary' : 'bg-surface'} hover:bg-surface-light transition-colors duration-150 divide-x divide-border-secondary`}
                  >
                    <td className='px-6 py-4'>
                      <div className='flex items-center'>
                        {host.hostname === DEFAULT_GLOBAL_KEY ? (
                          <span className='text-text-secondary max-w-xs truncate block' title={host.hostname}>
                            {t(DEFAULT_GLOBAL_KEY)}
                          </span>
                        ) : (
                          <a
                            href={`https://${host.hostname}`}
                            target='_blank'
                            rel='noopener noreferrer'
                            className='text-accent hover:text-accent-light underline-offset-2 hover:underline transition-colors duration-150 max-w-xs truncate block'
                            title={host.hostname}
                          >
                            {host.hostname}
                          </a>
                        )}
                      </div>
                    </td>
                    <td className={`px-6 py-4 ${getHighlightClass(host, 'policy')}`}>
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getPolicyBadgeClass(host.policy.behavior)}`}
                      >
                        {t(`HostSettings.Policy.${host.policy.behavior}`)}
                      </span>
                    </td>
                    <td className={`px-6 py-4 ${getHighlightClass(host, 'masking')}`}>
                      <div className='flex flex-wrap gap-1'>
                        <span className='inline-flex items-center px-2 py-0.5 rounded text-xs bg-surface-light text-text-secondary border border-border-secondary'>
                          {t('HostSettings.Masking.BlurIntensity.title')}: {host.masking.blurIntensity}%
                        </span>
                        <span className='inline-flex items-center px-2 py-0.5 rounded text-xs bg-surface-light text-text-secondary border border-border-secondary'>
                          {t('HostSettings.Masking.PixelationScale.title')}: {host.masking.pixelationScale}%
                        </span>
                        {host.masking.grayscale && (
                          <span className='inline-flex items-center px-2 py-0.5 rounded text-xs bg-surface-light text-text-secondary border border-border-secondary'>
                            {t('HostSettings.Masking.BlurTint.grayscale')}
                          </span>
                        )}
                        {host.masking.dark && (
                          <span className='inline-flex items-center px-2 py-0.5 rounded text-xs bg-surface-light text-text-secondary border border-border-secondary'>
                            {t('HostSettings.Masking.BlurTint.dark')}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className={`px-6 py-4 ${getHighlightClass(host, 'strictness')}`}>
                      <div className='flex items-center space-x-2'>
                        <div className='w-12 bg-border-secondary rounded-full h-2 relative'>
                          <div
                            className='bg-accent h-2 rounded-full transition-all duration-300'
                            style={{ width: `${(host.strictness / 1) * 100}%` }}
                          />
                        </div>
                        <span className='text-xs text-text-muted min-w-8'>{(host.strictness * 100).toFixed(0)}%</span>
                      </div>
                    </td>
                    <td className='px-6 py-4'>
                      <button
                        onClick={() => {
                          void handleRemoveHost(host.hostname);
                        }}
                        className='text-danger-light hover:text-danger text-sm px-3 py-1 rounded-md hover:bg-danger-light/10 transition-all duration-150 cursor-pointer'
                        title={t('Common.remove')}
                      >
                        {t('Common.remove')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
