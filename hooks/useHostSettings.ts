import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useCallback } from 'react';
import { sendMessage } from 'webext-bridge/popup';

import { defaultHostSettings } from '@/utils/db/constants';
import { hostSettingsDb } from '@/utils/db/db';
import { HostSettingsRepository } from '@/utils/db/hostSettingsRepository';
import { getEffectiveHostname, isGlobalPage } from '@/utils/hostnameUtil';
import { getIconPaths } from '@/utils/icons';

import type { MaskType, OutlineType, HostPolicy, IHostSettings } from '@/utils/types';

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
    if (!effectiveHostname) return;
    
    try {
      const tabs = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });
      const activeTab = tabs[0];

      if (activeTab?.id) {
        // Get current host settings to determine policy
        const currentSettings = hostSettingsData || {
          ...defaultHostSettings,
          hostname: effectiveHostname,
          isGlobal: isGlobalPage(effectiveHostname),
        };
        
        const iconPaths = getIconPaths(currentSettings.policy);
        await browser.action.setIcon({ tabId: activeTab.id, path: iconPaths });
      }
    } catch (error) {
      console.error('Error updating icon:', error);
    }
  }, [effectiveHostname, hostSettingsData]);

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

  // Create repository instance with enhanced methods that include side effects
  const repository = useMemo(() => {
    const baseRepository = new HostSettingsRepository();
    
    // Create a proxy that intercepts the methods we want to enhance
    return new Proxy(baseRepository, {
      get(target, prop) {
        const enhancedMethods = {
          togglePolicy: async (hostname: string) => {
            const result = await target.togglePolicy(hostname);
            await updateIcon();
            await notifyContentScripts();
            return result;
          },
          setOutline: async (hostname: string, outlineVariant: OutlineType) => {
            const result = await target.setOutline(hostname, outlineVariant);
            await updateIcon();
            await notifyContentScripts();
            return result;
          },
          setMask: async (hostname: string, maskArray: MaskType[]) => {
            const result = await target.setMask(hostname, maskArray);
            await updateIcon();
            await notifyContentScripts();
            return result;
          },
          setStrictness: async (hostname: string, strictness: number) => {
            const result = await target.setStrictness(hostname, strictness);
            await updateIcon();
            await notifyContentScripts();
            return result;
          },
          setPolicy: async (hostname: string, policy: HostPolicy) => {
            const result = await target.setPolicy(hostname, policy);
            await updateIcon();
            await notifyContentScripts();
            return result;
          },
          saveSettings: async (settings: IHostSettings) => {
            await target.saveSettings(settings);
            await updateIcon();
            await notifyContentScripts();
          }
        };
        
        return enhancedMethods[prop as keyof typeof enhancedMethods] || target[prop as keyof typeof target];
      }
    });
  }, [updateIcon, notifyContentScripts]);


  return {
    // Main settings - return plain settings without methods
    hostSettings: hostSettingsData || {
      ...defaultHostSettings,
      hostname: effectiveHostname,
      isGlobal: isGlobalPage(effectiveHostname),
    },

    // Repository instance
    hostSettingsRepository: repository,

    // Status
    isLoading: hostSettingsData === undefined,
    effectiveHostname,
  };
}
