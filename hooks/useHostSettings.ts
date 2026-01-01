import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';

import { DEFAULT_HOST_SETTINGS } from '@/utils/constants';
import { hostSettingsDb } from '@/utils/db/db';
import { HostSettingsRepository } from '@/utils/db/hostSettingsRepository';
import { getEffectiveHostname, isGlobalPage } from '@/utils/hostnameUtil';

/**
 * Reactive hook for HostSettings data management.
 * Uses Dexie's liveQuery for automatic reactivity when settings change.
 * Side effects (icon updates, content script notifications) are handled by
 * the background's HostSettingsObserver watching the same database.
 *
 * @param hostname - The hostname to load settings for
 * @returns Host settings and loading state
 */
export function useHostSettings(hostname: string) {
  const effectiveHostname = useMemo(() => getEffectiveHostname(hostname), [hostname]);

  const hostSettingsData = useLiveQuery(() => hostSettingsDb.hostSettings.get(effectiveHostname), [effectiveHostname]);

  const repository = useMemo(() => new HostSettingsRepository(), []);

  return {
    hostSettings: hostSettingsData || {
      ...DEFAULT_HOST_SETTINGS,
      hostname: effectiveHostname,
      isGlobal: isGlobalPage(effectiveHostname),
    },
    hostSettingsRepository: repository,
    isLoading: hostSettingsData === undefined,
    effectiveHostname,
  };
}
