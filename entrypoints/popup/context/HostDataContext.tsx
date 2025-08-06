import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from 'react';

import { useHostname } from '@/hooks/useHostname';
import { useHostSettings } from '@/hooks/useHostSettings';
import { defaultGlobalKey, defaultHostSettings } from '@/utils/db/constants';
import { type HostSettingsRepository } from '@/utils/db/hostSettingsRepository';
import { PredictionCacheRepository } from '@/utils/db/predictionCacheRepository';

import type { IHostSettings } from '@/utils/types';

type HostDataType = {
  hostSettings: IHostSettings;
  currentHostname: string;
  isLoading: boolean;
  error?: string;
  hostSettingsRepository: HostSettingsRepository;
  predictionCacheRepository: PredictionCacheRepository;
  switchToGlobal: () => void;
  switchToLocal: () => void;
  isGlobalMode: boolean;
};

const HostDataContext = createContext<HostDataType>({
  hostSettings: defaultHostSettings,
  currentHostname: defaultGlobalKey,
  isLoading: false,
  hostSettingsRepository: {} as HostSettingsRepository,
  predictionCacheRepository: new PredictionCacheRepository(),
  switchToGlobal: () => {},
  switchToLocal: () => {},
  isGlobalMode: false,
});

type HostDataProviderProps = {
  children: ReactNode;
};

export const HostDataProvider = ({ children }: HostDataProviderProps) => {
  const { currentHostname: detectedHostname, error: hostnameError } =
    useHostname();
  const [isGlobalMode, setIsGlobalMode] = useState(false);

  const currentHostname = isGlobalMode ? defaultGlobalKey : detectedHostname;
  const { hostSettings, hostSettingsRepository, isLoading } =
    useHostSettings(currentHostname);
  const error = hostnameError;
  const predictionCacheRepository = new PredictionCacheRepository();

  // Check global settings to enforce global mode if policy !== "process"
  useEffect(() => {
    const checkGlobalSettings = async () => {
      try {
        const globalSettings =
          await hostSettingsRepository.findByHostname(defaultGlobalKey);

        if (globalSettings.policy !== 'process') {
          setIsGlobalMode(true);
        }
      } catch {
        // Do nothing
      }
    };

    if (hostSettingsRepository && !isLoading) {
      void checkGlobalSettings();
    }
  }, [hostSettingsRepository, isLoading]);

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
        predictionCacheRepository,
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
    throw new Error(
      'useHostDataContext must be used within a HostDataProvider',
    );
  }
  return context;
};
