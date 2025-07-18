import { useMemo, useCallback } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { sendMessage } from 'webext-bridge/popup';
import { HostSettings, defaultHostSettings } from '@/utils/db/hostSettings';
import { getEffectiveHostname, isGlobalPage } from '@/utils/db/hostnameUtil';
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

  // Function to update icon after settings change
  const updateIcon = useCallback(async () => {
    if (effectiveHostname) {
      try {
        await sendMessage('UPDATE_ICON', { hostname: effectiveHostname });
      } catch (error) {
        console.error('Error updating icon:', error);
      }
    }
  }, [effectiveHostname]);

  // Create HostSettings instance from the data
  const hostSettings = useMemo(() => {
    if (hostSettingsData) {
      const settings = new HostSettings(hostSettingsData);
      // Override the save method to trigger icon updates
      const originalSave = settings.save.bind(settings);
      settings.save = async () => {
        await originalSave();
        await updateIcon();
      };
      return settings;
    }
    // Return default settings if no data found
    const settings = new HostSettings({
      ...defaultHostSettings,
      hostname: effectiveHostname,
      isGlobal: isGlobalPage(effectiveHostname),
    });
    // Override the save method to trigger icon updates
    const originalSave = settings.save.bind(settings);
    settings.save = async () => {
      await originalSave();
      await updateIcon();
    };
    return settings;
  }, [hostSettingsData, effectiveHostname, updateIcon]);

  return {
    // Main settings
    hostSettings,
    
    // Status
    isLoading: hostSettingsData === undefined,
    effectiveHostname,
  };
}
