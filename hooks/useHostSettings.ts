import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useCallback } from 'react';
import { sendMessage } from 'webext-bridge/popup';

import { DEFAULT_HOST_SETTINGS } from '@/utils/constants';
import { hostSettingsDb } from '@/utils/db/db';
import { HostSettingsRepository } from '@/utils/db/hostSettingsRepository';
import { getEffectiveHostname, isGlobalPage } from '@/utils/hostnameUtil';
import { getIconPaths } from '@/utils/icons';
import { logger } from '@/utils/logger';

import type { OutlineType, HostPolicy, IHostSettings } from '@/utils/types';

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
  const hostSettingsData = useLiveQuery(() => hostSettingsDb.hostSettings.get(effectiveHostname), [effectiveHostname]);

  // Function to update icon with specific policy
  const updateIconFromPolicy = useCallback(
    async (policy: HostPolicy) => {
      if (!effectiveHostname) return;

      try {
        const tabs = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        const activeTab = tabs[0];

        if (activeTab?.id) {
          const currentSettings = {
            ...DEFAULT_HOST_SETTINGS,
            hostname: effectiveHostname,
            isGlobal: isGlobalPage(effectiveHostname),
            policy,
          };
          // Setting global policy icon
          if (currentSettings.isGlobal && currentSettings.policy !== 'process') {
            const iconPaths = getIconPaths(currentSettings.policy);
            await (browser.action ?? browser.browserAction).setIcon({
              tabId: activeTab.id,
              path: iconPaths,
            });
          }

          // Setting local policy icon from the tab's hostname
          else if (currentSettings.isGlobal && currentSettings.policy === 'process') {
            const hostnameOfTheTab = new URL(activeTab.url || '').hostname;
            const effectiveTabHostname = getEffectiveHostname(hostnameOfTheTab);
            const tabSettings = (await hostSettingsDb.hostSettings.get(effectiveTabHostname)) || DEFAULT_HOST_SETTINGS;
            const iconPaths = getIconPaths(tabSettings.policy);
            await (browser.action ?? browser.browserAction).setIcon({
              tabId: activeTab.id,
              path: iconPaths,
            });
          } else {
            // Not global policy, set currentSettings icon
            const iconPaths = getIconPaths(currentSettings.policy);
            await (browser.action ?? browser.browserAction).setIcon({
              tabId: activeTab.id,
              path: iconPaths,
            });
          }
        }
      } catch (error) {
        logger.withTag('useHostSettings').error('Error updating icon:', error);
      }
    },
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
          ...DEFAULT_HOST_SETTINGS,
          hostname: effectiveHostname,
          isGlobal: isGlobalPage(effectiveHostname),
        };

        // Setting global policy icon
        if (currentSettings.isGlobal && currentSettings.policy !== 'process') {
          const iconPaths = getIconPaths(currentSettings.policy);
          await (browser.action ?? browser.browserAction).setIcon({
            tabId: activeTab.id,
            path: iconPaths,
          });
        }

        // Setting local policy icon from the tab's hostname
        else if (currentSettings.isGlobal && currentSettings.policy === 'process') {
          const hostnameOfTheTab = new URL(activeTab.url || '').hostname;
          const effectiveTabHostname = getEffectiveHostname(hostnameOfTheTab);
          const tabSettings = (await hostSettingsDb.hostSettings.get(effectiveTabHostname)) || DEFAULT_HOST_SETTINGS;
          const iconPaths = getIconPaths(tabSettings.policy);
          await (browser.action ?? browser.browserAction).setIcon({
            tabId: activeTab.id,
            path: iconPaths,
          });
        } else {
          // Not global policy, set currentSettings icon
          const iconPaths = getIconPaths(currentSettings.policy);
          await (browser.action ?? browser.browserAction).setIcon({
            tabId: activeTab.id,
            path: iconPaths,
          });
        }
      }
    } catch (error) {
      logger.withTag('useHostSettings').error('Error updating icon:', error);
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
              logger
                .withTag('useHostSettings')
                .warn(
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
        logger.withTag('useHostSettings').error('Error notifying content scripts:', error);
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
            await updateIconFromPolicy(result.policy);
            await notifyContentScripts();
            return result;
          },
          setOutline: async (hostname: string, outlineVariant: OutlineType) => {
            const result = await target.setOutline(hostname, outlineVariant);
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
          },
        };

        return enhancedMethods[prop as keyof typeof enhancedMethods] || target[prop as keyof typeof target];
      },
    });
  }, [updateIcon, updateIconFromPolicy, notifyContentScripts]);

  return {
    // Main settings - return plain settings without methods
    hostSettings: hostSettingsData || {
      ...DEFAULT_HOST_SETTINGS,
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
