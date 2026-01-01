import { useLiveQuery } from 'dexie-react-hooks';
import { createContext, useContext, useState, useEffect, useMemo, type ReactNode } from 'react';

import { useHostname } from '@/hooks/useHostname';
import { DEFAULT_GLOBAL_KEY, DEFAULT_HOST_SETTINGS } from '@/utils/constants';
import { hostSettingsDb } from '@/utils/db/db';
import { hostSettingsRepository, type HostSettingsRepository } from '@/utils/db/hostSettingsRepository';
import { ImageCacheRepository } from '@/utils/db/imageCacheRepository';
import { getEffectiveHostname, isGlobalPage } from '@/utils/hostnameUtil';

import type { IHostSettings } from '@/utils/types';

type HostDataType = {
  hostSettings: IHostSettings;
  currentHostname: string;
  isLoading: boolean;
  error?: string;
  hostSettingsRepository: HostSettingsRepository;
  imageCacheRepository: ImageCacheRepository;
  switchToGlobal: () => void;
  switchToLocal: () => void;
  isGlobalMode: boolean;
};

const HostDataContext = createContext<HostDataType>({
  hostSettings: DEFAULT_HOST_SETTINGS,
  currentHostname: DEFAULT_GLOBAL_KEY,
  isLoading: false,
  hostSettingsRepository: {} as HostSettingsRepository,
  imageCacheRepository: {} as ImageCacheRepository,
  switchToGlobal: () => {},
  switchToLocal: () => {},
  isGlobalMode: false,
});

type HostDataProviderProps = {
  children: ReactNode;
};

export const HostDataProvider = ({ children }: HostDataProviderProps) => {
  const { currentHostname: detectedHostname, error: hostnameError } = useHostname();
  const [isGlobalMode, setIsGlobalMode] = useState(false);

  const currentHostname = isGlobalMode ? DEFAULT_GLOBAL_KEY : detectedHostname;
  const effectiveHostname = useMemo(() => getEffectiveHostname(currentHostname), [currentHostname]);
  const hostSettingsData = useLiveQuery(() => hostSettingsDb.hostSettings.get(effectiveHostname), [effectiveHostname]);
  const hostSettings = hostSettingsData || {
    ...DEFAULT_HOST_SETTINGS,
    hostname: effectiveHostname,
    isGlobal: isGlobalPage(effectiveHostname),
  };
  const isLoading = hostSettingsData === undefined;
  const error = hostnameError;
  const imageCacheRepository = useMemo(() => new ImageCacheRepository(), []);

  // Check global settings to enforce global mode if policy !== "process"
  useEffect(() => {
    const checkGlobalSettings = async () => {
      try {
        const globalSettings = await hostSettingsRepository.findByHostname(DEFAULT_GLOBAL_KEY);

        if (globalSettings.policy !== 'process') {
          setIsGlobalMode(true);
        }
      } catch {
        // Do nothing
      }
    };

    if (!isLoading) {
      void checkGlobalSettings();
    }
  }, [isLoading]);

  const switchToGlobal = () => setIsGlobalMode(true);
  const switchToLocal = () => setIsGlobalMode(false);

  if (error) {
    return <div>Error: {error}</div>;
  }

  return (
    <HostDataContext.Provider
      value={{
        hostSettings,
        currentHostname,
        isLoading,
        error,
        hostSettingsRepository,
        imageCacheRepository,
        switchToGlobal,
        switchToLocal,
        isGlobalMode,
      }}
    >
      {children}
    </HostDataContext.Provider>
  );
};

export const useHostDataContext = (): HostDataType => {
  const context = useContext(HostDataContext);
  if (!context) {
    throw new Error('useHostDataContext must be used within a HostDataProvider');
  }
  return context;
};
