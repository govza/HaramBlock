import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useCallback } from 'react';
import { sendMessage } from 'webext-bridge/popup';

import { defaultHostSettings } from '@/utils/db/constants';
import { hostSettingsDb } from '@/utils/db/db';
import { HostSettings } from '@/utils/db/hostSettings';
import { getEffectiveHostname, isGlobalPage } from '@/utils/hostnameUtil';

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
    [effectiveHostname],
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

  // Function to notify content scripts of settings changes
  const notifyContentScripts = useCallback(async () => {
    if (effectiveHostname) {
      try {
        // Get all tabs and find ones matching this hostname
        const tabs = await browser.tabs.query({});
        const relevantTabs = tabs.filter(tab => {
          if (!tab.url) return false;
          try {
            const tabHostname = new URL(tab.url).hostname;
            return getEffectiveHostname(tabHostname) === effectiveHostname;
          } catch {
            return false;
          }
        });

        // Send message to all relevant content scripts
        const notifications = relevantTabs.map(tab => {
          if (tab.id) {
            return sendMessage(
              'HOST_SETTINGS_UPDATED',
              { hostname: effectiveHostname },
              `content-script@${tab.id}`,
            ).catch(error => {
              // Ignore errors for tabs that might not have content script loaded
              console.warn(
                'Could not notify tab',
                tab.id,
                'of settings change:',
                error instanceof Error ? error.message : String(error),
              );
            });
          }
          return Promise.resolve();
        });

        await Promise.all(notifications);
      } catch (error) {
        console.error('Error notifying content scripts:', error);
      }
    }
  }, [effectiveHostname]);

  // Create HostSettings instance from the data
  const hostSettings = useMemo(() => {
    if (hostSettingsData) {
      const settings = new HostSettings(hostSettingsData);
      // Override the save method to trigger icon updates and notify content scripts
      const originalSave = settings.save.bind(settings);
      settings.save = async () => {
        await originalSave();
        await updateIcon();
        await notifyContentScripts();
      };
      return settings;
    }
    // Return default settings if no data found
    const settings = new HostSettings({
      ...defaultHostSettings,
      hostname: effectiveHostname,
      isGlobal: isGlobalPage(effectiveHostname),
    });
    // Override the save method to trigger icon updates and notify content scripts
    const originalSave = settings.save.bind(settings);
    settings.save = async () => {
      await originalSave();
      await updateIcon();
      await notifyContentScripts();
    };
    return settings;
  }, [hostSettingsData, effectiveHostname, updateIcon, notifyContentScripts]);

  return {
    // Main settings
    hostSettings,

    // Status
    isLoading: hostSettingsData === undefined,
    effectiveHostname,
  };
}
