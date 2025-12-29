import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useCallback } from 'react';

import { DEFAULT_HOST_SETTINGS } from '@/utils/constants';
import { hostSettingsDb } from '@/utils/db/db';
import { HostSettingsRepository } from '@/utils/db/hostSettingsRepository';
import { getEffectiveHostname, isGlobalPage } from '@/utils/hostnameUtil';
import { getIconPaths } from '@/utils/icons';
import { logger } from '@/utils/logger';
import { backgroundRpc } from '@/utils/messaging/popup';

import type { HostPolicy, IHostSettings } from '@/utils/types';

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

  // Function to notify content scripts of settings changes via background RPC
  const notifyContentScripts = useCallback(() => {
    if (effectiveHostname) {
      try {
        backgroundRpc.notifyHostSettingsChanged(effectiveHostname);
      } catch (error) {
        logger.withTag('useHostSettings').error('Error notifying content scripts:', error);
      }
    }
  }, [effectiveHostname]);

  // Create repository instance with enhanced methods that include side effects
  const repository = useMemo(() => {
    const baseRepository = new HostSettingsRepository();

    // Pattern for methods that mutate settings and need side effects
    const isMutatingMethod = (name: string): boolean =>
      name.startsWith('set') ||
      name.startsWith('toggle') ||
      name.startsWith('save') ||
      name.startsWith('create') ||
      name === 'delete';

    // Create a proxy that wraps all mutating methods with side effects
    return new Proxy(baseRepository, {
      get(target, prop) {
        const value = target[prop as keyof typeof target];

        // Wrap mutating methods to trigger icon update and content script notification
        if (typeof prop === 'string' && typeof value === 'function' && isMutatingMethod(prop)) {
          return async (...args: unknown[]) => {
            const method = value as (...args: unknown[]) => Promise<unknown>;
            const result = await method.apply(target, args);

            // Update icon: togglePolicy uses returned policy directly, others read from state
            if (prop === 'togglePolicy' && result && typeof result === 'object' && 'policy' in result) {
              await updateIconFromPolicy((result as IHostSettings).policy);
            } else {
              await updateIcon();
            }

            // Notify content scripts to reload with new settings (all mutating methods)
            notifyContentScripts();
            return result;
          };
        }

        return value;
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
