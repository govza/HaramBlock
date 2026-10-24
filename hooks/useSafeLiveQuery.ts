import { useLiveQuery } from 'dexie-react-hooks';
import { useState, useEffect } from 'react';

/**
 * Dexie's useLiveQuery that also re-runs on `storage.session` changes, where private-tab host
 * settings live, so one hook serves both normal and private tabs.
 */
export const useSafeLiveQuery = <T>(querier: () => Promise<T>, deps: unknown[]): T | undefined => {
  const [sessionVersion, setSessionVersion] = useState(0);

  useEffect(() => {
    const handleStorageChange = (_changes: Record<string, unknown>, areaName: string) => {
      if (areaName === 'session') setSessionVersion(version => version + 1);
    };
    browser.storage.onChanged.addListener(handleStorageChange);
    return () => browser.storage.onChanged.removeListener(handleStorageChange);
  }, []);

  return useLiveQuery(querier, [...deps, sessionVersion]);
};
