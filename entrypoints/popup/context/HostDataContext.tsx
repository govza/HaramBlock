import { createContext, useContext, type ReactNode } from 'react';

import { useHostname } from '@/hooks/useHostname';
import { useHostSettings } from '@/hooks/useHostSettings';
import { defaultGlobalKey, defaultHostSettings } from '@/utils/db/constants';
import { PredictionCacheRepository } from '@/utils/db/predictionCacheRepository';

import type {
  IHostSettings,
  MaskType,
  OutlineType,
  HostPolicy,
} from '@/utils/types';

type HostSettingsWithMethods = IHostSettings & {
  togglePolicy(): Promise<void>;
  setOutline(outlineVariant: OutlineType): Promise<void>;
  setMask(maskArray: MaskType[]): Promise<void>;
  setStrictness(strictness: number): Promise<void>;
  setPolicy(policy: HostPolicy): Promise<void>;
  save(): Promise<void>;
};

type HostDataType = {
  hostSettings: HostSettingsWithMethods;
  currentHostname: string;
  isLoading: boolean;
  error?: string;
  predictionCacheRepository: PredictionCacheRepository;
};

const HostDataContext = createContext<HostDataType>({
  hostSettings: {
    ...defaultHostSettings,
    async togglePolicy() {},
    async setOutline() {},
    async setMask() {},
    async setStrictness() {},
    async setPolicy() {},
    async save() {},
  },
  currentHostname: defaultGlobalKey,
  isLoading: false,
  predictionCacheRepository: new PredictionCacheRepository(),
});

type HostDataProviderProps = {
  children: ReactNode;
};

export const HostDataProvider = ({ children }: HostDataProviderProps) => {
  const { currentHostname, error: hostnameError } = useHostname();
  const { hostSettings, isLoading } = useHostSettings(currentHostname);
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
