import { createContext, useContext, type ReactNode } from 'react';

import { useHostname } from '@/hooks/useHostname';
import { useHostSettings } from '@/hooks/useHostSettings';
import { defaultGlobalKey, defaultHostSettings } from '@/utils/db/constants';
import { PredictionCacheRepository } from '@/utils/db/predictionCacheRepository';

import type { HostSettingsRepository } from '@/utils/db/hostSettingsRepository';
import type { IHostSettings } from '@/utils/types';

type HostDataType = {
  hostSettings: IHostSettings;
  currentHostname: string;
  isLoading: boolean;
  error?: string;
  hostSettingsRepository: HostSettingsRepository;
  predictionCacheRepository: PredictionCacheRepository;
};

const HostDataContext = createContext<HostDataType>({
  hostSettings: defaultHostSettings,
  currentHostname: defaultGlobalKey,
  isLoading: false,
  hostSettingsRepository: {} as HostSettingsRepository,
  predictionCacheRepository: new PredictionCacheRepository(),
});

type HostDataProviderProps = {
  children: ReactNode;
};

export const HostDataProvider = ({ children }: HostDataProviderProps) => {
  const { currentHostname, error: hostnameError } = useHostname();
  const { hostSettings, hostSettingsRepository, isLoading } = useHostSettings(currentHostname);
  const error = hostnameError;
  const predictionCacheRepository = new PredictionCacheRepository();

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
        predictionCacheRepository,
      }}
    >
      {children}
    </HostDataContext.Provider>
  );
};

export const useHostDataContext = (): HostDataType => {
  const context = useContext(HostDataContext);
  if (!context) {
    throw new Error(
      'useHostDataContext must be used within a HostDataProvider',
    );
  }
  return context;
};
