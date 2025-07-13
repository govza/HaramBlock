import { useMemo, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { HostSettings, defaultGlobalKey, defaultHostSettings } from '@/utils/db/hostSettings';
import { hostSettingsDb } from '@/utils/db/db';

/**
 * Reactive hook for HostSettings data management
 * Focuses purely on loading and managing settings for a specific hostname
 * 
 * @param hostname - The hostname to load settings for
 * @returns Host settings and loading state
 */
export function useHostSettings(hostname: string) {
  // Get the effective hostname for database lookup
  const effectiveHostname = useMemo(() => {
    if (!hostname || HostSettings.globalPages.includes(hostname)) {
      return defaultGlobalKey;
    }
    return hostname;
  }, [hostname]);

  // Reactively query the database
  const hostSettingsData = useLiveQuery(
    () => hostSettingsDb.hostSettings.get(effectiveHostname),
    [effectiveHostname]
  );

  // Create HostSettings instance from the data
  const hostSettings = useMemo(() => {
    if (hostSettingsData) {
      return new HostSettings(hostSettingsData);
    }
    // Return default settings if no data found
    return new HostSettings({
      ...defaultHostSettings,
      hostname: effectiveHostname,
      isGlobal: effectiveHostname === defaultGlobalKey,
    });
  }, [hostSettingsData, effectiveHostname]);

  // Initialize default settings if none exist
  useEffect(() => {
    if (hostSettingsData === undefined && effectiveHostname) {
      // Data is loading, wait for it
      return;
    }
    if (hostSettingsData === null) {
      // No data found, create default settings
      const defaultSettings = new HostSettings({
        ...defaultHostSettings,
        hostname: effectiveHostname,
        isGlobal: effectiveHostname === defaultGlobalKey,
      });
      defaultSettings.save().catch(console.error);
    }
  }, [hostSettingsData, effectiveHostname]);

  return {
    // Main settings
    hostSettings,
    
    // Status
    isLoading: hostSettingsData === undefined,
    effectiveHostname,
  };
}
