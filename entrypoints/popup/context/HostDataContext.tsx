import { createContext, useContext, useState, useMemo, useEffect, useRef, useCallback, type ReactNode } from 'react';

import { useHostname } from '@/hooks/useHostname';
import { useSafeLiveQuery } from '@/hooks/useSafeLiveQuery';
import { DEFAULT_GLOBAL_KEY, DEFAULT_HOST_SETTINGS } from '@/utils/constants';
import { isIncognito } from '@/utils/db/db';
import { createHostSettingsRepository, type HostSettingsRepository } from '@/utils/db/hostSettingsRepository';
import { ImageCacheRepository } from '@/utils/db/imageCacheRepository';
import { getEffectiveHostname, isGlobalPage } from '@/utils/hostnameUtil';
import { backgroundRpc } from '@/utils/messaging/popup';

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
  isDirty: boolean;
  markDirty: () => void;
  reloadTab: () => void;
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
  isDirty: false,
  markDirty: () => {},
  reloadTab: () => {},
});

type HostDataProviderProps = {
  children: ReactNode;
};

export const HostDataProvider = ({ children }: HostDataProviderProps) => {
  const { currentHostname: detectedHostname, error: hostnameError } = useHostname();
  const [isGlobalMode, setIsGlobalMode] = useState(false);

  const currentHostname = isGlobalMode ? DEFAULT_GLOBAL_KEY : detectedHostname;
  const effectiveHostname = useMemo(() => getEffectiveHostname(currentHostname), [currentHostname]);

  const hostSettingsRepository = useMemo(() => createHostSettingsRepository(isIncognito), []);

  const hostSettingsData = useSafeLiveQuery(
    () => hostSettingsRepository.findByHostname(effectiveHostname),
    [effectiveHostname],
  );

  const hostSettings = hostSettingsData || {
    ...DEFAULT_HOST_SETTINGS,
    hostname: effectiveHostname,
    isGlobal: isGlobalPage(effectiveHostname),
  };
  const isLoading = hostSettingsData === undefined;
  const error = hostnameError;
  const imageCacheRepository = useMemo(() => new ImageCacheRepository(), []);

  const switchToGlobal = () => setIsGlobalMode(true);
  const switchToLocal = () => setIsGlobalMode(false);

  // Update toolbar icon when the policy behavior changes (skip initial load)
  const prevPolicyRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevPolicyRef.current === null) {
      prevPolicyRef.current = hostSettings.policy.behavior;
      return;
    }
    if (prevPolicyRef.current !== hostSettings.policy.behavior) {
      prevPolicyRef.current = hostSettings.policy.behavior;
      void backgroundRpc.updateIcon(effectiveHostname);
    }
  }, [hostSettings.policy.behavior, effectiveHostname]);

  const [isDirty, setIsDirty] = useState(false);
  const markDirty = useCallback(() => setIsDirty(true), []);

  const reloadTab = useCallback(() => {
    void browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      const tabId = tabs[0]?.id;
      if (tabId !== undefined) {
        void browser.tabs.reload(tabId);
      }
    });
    setIsDirty(false);
  }, []);

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
        isDirty,
        markDirty,
        reloadTab,
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
