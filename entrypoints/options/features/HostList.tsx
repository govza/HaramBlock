import { useState, useEffect } from 'react';

import { LoadingSpinner } from '@/entrypoints/options/components/LoadingSpinner';
import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { t } from '@/utils/i18n';
import { logger } from '@/utils/logger';

import type { IHostSettings } from '@/utils/types';

export const HostList = () => {
  const { hostSettingsRepository, isLoading } = useHostDataContext();
  const [activeTab, setActiveTab] = useState<'whitelist' | 'blacklist'>('whitelist');
  const [whitelistHosts, setWhitelistHosts] = useState<IHostSettings[]>([]);
  const [blacklistHosts, setBlacklistHosts] = useState<IHostSettings[]>([]);
  const [newHostname, setNewHostname] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const loadHosts = async () => {
      if (!hostSettingsRepository) return;

      try {
        const allHosts = await hostSettingsRepository.findAll();
        const whitelist = allHosts.filter(host => host.policy === 'whitelist' && !host.isGlobal);
        const blacklist = allHosts.filter(host => host.policy === 'blacklist' && !host.isGlobal);

        setWhitelistHosts(whitelist);
        setBlacklistHosts(blacklist);
      } catch (error) {
        logger.withTag('HostList').error('Failed to load hosts:', error);
      }
    };

    void loadHosts();
  }, [hostSettingsRepository]);

  const handleAddHost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newHostname.trim() || !hostSettingsRepository || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await hostSettingsRepository.createHostSettings({
        hostname: newHostname.trim(),
        policy: activeTab,
      });

      const newHost = await hostSettingsRepository.findByHostname(newHostname.trim());

      if (activeTab === 'whitelist') {
        setWhitelistHosts(prev => [...prev, newHost]);
      } else {
        setBlacklistHosts(prev => [...prev, newHost]);
      }

      setNewHostname('');
    } catch (error) {
      logger.withTag('HostList').error('Failed to add host:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemoveHost = async (hostname: string) => {
    if (!hostSettingsRepository) return;

    try {
      await hostSettingsRepository.delete(hostname);

      if (activeTab === 'whitelist') {
        setWhitelistHosts(prev => prev.filter(host => host.hostname !== hostname));
      } else {
        setBlacklistHosts(prev => prev.filter(host => host.hostname !== hostname));
      }
    } catch (error) {
      logger.withTag('HostList').error('Failed to remove host:', error);
    }
  };

  const currentHosts = activeTab === 'whitelist' ? whitelistHosts : blacklistHosts;

  if (isLoading) {
    return <LoadingSpinner />;
  }

  return (
    <div className='space-y-6'>
      <div className='border-b border-border-primary pb-4'>
        <h2 className='text-2xl font-bold text-text-primary mb-2'>{t('HostSettings.HostList.title')}</h2>
        <p className='text-text-muted text-base'>{t('HostSettings.HostList.description')}</p>
      </div>

      {/* Tab Navigation */}
      <div className='inline-flex border-b border-border-secondary overflow-hidden'>
        <button
          onClick={() => setActiveTab('whitelist')}
          className={`px-6 py-3 text-base font-medium transition-all duration-300 cursor-pointer relative rounded-tl-lg ${
            activeTab === 'whitelist'
              ? 'bg-surface text-text-primary border-b-2 border-accent shadow-sm'
              : 'bg-secondary text-text-muted hover:text-text-primary hover:bg-surface'
          }`}
        >
          {t('HostSettings.HostList.whiteList')} ({whitelistHosts.length})
          {activeTab === 'whitelist' && (
            <div className='absolute bottom-0 left-0 right-0 h-0.5 bg-accent animate-pulse' />
          )}
        </button>
        <button
          onClick={() => setActiveTab('blacklist')}
          className={`px-6 py-3 text-base font-medium transition-all duration-300 cursor-pointer relative rounded-tr-lg ${
            activeTab === 'blacklist'
              ? 'bg-surface text-text-primary border-b-2 border-accent shadow-sm'
              : 'bg-secondary text-text-muted hover:text-text-primary hover:bg-surface'
          }`}
        >
          {t('HostSettings.HostList.blackList')} ({blacklistHosts.length})
          {activeTab === 'blacklist' && (
            <div className='absolute bottom-0 left-0 right-0 h-0.5 bg-accent animate-pulse' />
          )}
        </button>
      </div>

      <div className='space-y-4'>
        {/* Tab Content with Animation */}
        <div className='bg-secondary rounded-lg overflow-hidden transition-all duration-300 ease-in-out'>
          <div className='opacity-100 animate-fade-in'>
            {/* Add Host Form */}
            <div className='p-4 border-b border-border-secondary'>
              <form
                onSubmit={e => {
                  void handleAddHost(e);
                }}
                className='flex space-x-2'
              >
                <input
                  type='text'
                  value={newHostname}
                  onChange={e => setNewHostname(e.target.value)}
                  className='flex-1 bg-surface border border-border-secondary text-text-secondary text-base rounded-lg p-2'
                  placeholder='example.com'
                  disabled={isSubmitting}
                />
                <button
                  type='submit'
                  disabled={!newHostname.trim() || isSubmitting}
                  className='bg-surface hover:bg-surface-light text-text-primary px-4 py-2 rounded-lg text-base ring-2 ring-accent-light ring-opacity-50 transition-all duration-150 hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 cursor-pointer'
                >
                  {isSubmitting ? 'Adding...' : t('Common.add')}
                </button>
              </form>
            </div>

            {/* Host List */}
            <div className='p-4'>
              {currentHosts.length === 0 ? (
                <p className='text-text-muted text-base py-4'>{t('Common.noData')}</p>
              ) : (
                <div className='space-y-2'>
                  {currentHosts.map(host => (
                    <div key={host.hostname} className='flex items-center justify-between bg-surface p-3 rounded'>
                      <span className='text-text-secondary text-base'>{host.hostname}</span>
                      <button
                        onClick={() => {
                          void handleRemoveHost(host.hostname);
                        }}
                        className='text-danger-light hover:text-danger text-sm px-2 py-1 rounded transition-colors cursor-pointer'
                      >
                        {t('Common.remove')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
