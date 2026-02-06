import { useLiveQuery } from 'dexie-react-hooks';
import { useState, useEffect, useRef } from 'react';

import { isIncognito } from '@/utils/db/db';

type LiveQueryHook = <T>(querier: () => Promise<T>, deps: unknown[]) => T | undefined;

/**
 * Incognito implementation: useState + useEffect with storage.session listener.
 * Uses a ref for the querier so the storage listener always calls the latest version.
 */
const useIncognitoLiveQuery: LiveQueryHook = <T>(querier: () => Promise<T>, deps: unknown[]) => {
  const [data, setData] = useState<T | undefined>(undefined);
  const querierRef = useRef(querier);
  querierRef.current = querier;

  // Re-run query when deps change
  useEffect(() => void querierRef.current().then(setData), deps);

  // Re-run query on session storage changes only
  useEffect(() => {
    const handleStorageChange = (_changes: Record<string, unknown>, areaName: string) => {
      if (areaName === 'session') {
        void querierRef.current().then(setData);
      }
    };
    browser.storage.onChanged.addListener(handleStorageChange);
    return () => browser.storage.onChanged.removeListener(handleStorageChange);
  }, []);

  return data;
};

/**
 * Normal implementation: delegates directly to Dexie's useLiveQuery.
 */
const useIndexedDbLiveQuery: LiveQueryHook = <T>(querier: () => Promise<T>, deps: unknown[]) => {
  return useLiveQuery(querier, deps);
};

/**
 * A wrapper around useLiveQuery that works in incognito mode.
 * - Normal mode: Uses Dexie's useLiveQuery with live IndexedDB updates
 * - Incognito mode: Uses useState + useEffect with storage.session, auto-refreshes on storage changes
 */
export const useSafeLiveQuery: LiveQueryHook = isIncognito ? useIncognitoLiveQuery : useIndexedDbLiveQuery;
