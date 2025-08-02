import { createContext, useContext, type ReactNode } from 'react';

import { useHostname } from '@/hooks/useHostname';
import { useHostSettings } from '@/hooks/useHostSettings';
import { defaultGlobalKey, defaultHostSettings } from '@/utils/db/constants';
import { HostSettings } from '@/utils/db/hostSettings';

type HostDataType = {
  hostSettings: HostSettings;
  currentHostname: string;
  isLoading: boolean;
  error?: string;
};

const HostDataContext = createContext<HostDataType>({
  hostSettings: new HostSettings(defaultHostSettings),
  currentHostname: defaultGlobalKey,
  isLoading: false,
});

type HostDataProviderProps = {
  children: ReactNode;
};

export const HostDataProvider = ({ children }: HostDataProviderProps) => {
  // Get hostname management
  const { currentHostname, error: hostnameError } = useHostname();

  // Get settings for the current hostname
  const { hostSettings, isLoading } = useHostSettings(currentHostname);

  const error = hostnameError;

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
