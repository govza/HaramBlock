import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { HostSettings, defaultGlobalKey, defaultHostSettings } from '@/utils/db/hostSettings';
import { getEffectiveHostname } from '@/utils/db/hostnameUtil';
import { hostSettingsDb } from '@/utils/db/db';

/**
 * Reactive hook for HostSettings data management
 * Focuses purely on loading and managing settings for a specific hostname
 * 
 * @param hostname - The hostname to load settings for
 * @returns Host settings and loading state
 */
export function useHostSettings(hostname: string) {
  // Get the effective hostname for database lookup using centralized logic
  const effectiveHostname = useMemo(() => {
    return getEffectiveHostname(hostname);
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
    // Return default settings if no data found (NO auto-save)
    const settings = new HostSettings({
      ...defaultHostSettings,
      hostname: effectiveHostname,
      isGlobal: effectiveHostname === defaultGlobalKey,
    });
    return settings;
  }, [hostSettingsData, effectiveHostname]);

  return {
    // Main settings
    hostSettings,
    
    // Status
    isLoading: hostSettingsData === undefined,
    effectiveHostname,
  };
}
