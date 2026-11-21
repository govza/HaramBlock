import { IS_CHROME } from '@/utils/constants/environment';

import type { Browser } from 'wxt/browser';

type FirefoxDataCollection = 'browsingActivity' | 'websiteContent';

/**
 * The permissions request Firefox 142+ accepts for optional data-collection types, which the
 * Chrome-generated `Browser.permissions.Permissions` typing does not know about.
 */
interface DataCollectionPermissions extends Browser.permissions.Permissions {
  data_collection: FirefoxDataCollection[];
}

const CLOUD_PREDICTIONS_DATA_COLLECTION: DataCollectionPermissions = {
  data_collection: ['browsingActivity', 'websiteContent'],
};

/**
 * Shows Firefox's own data-collection prompt; must run inside the agree click's user gesture, so
 * callers invoke it before any other await. Chrome has no such prompt and always grants.
 */
export const requestDataCollection = async (): Promise<boolean> => {
  if (IS_CHROME) return true;
  return browser.permissions.request(CLOUD_PREDICTIONS_DATA_COLLECTION);
};

export const hasDataCollection = async (): Promise<boolean> => {
  if (IS_CHROME) return true;
  return browser.permissions.contains(CLOUD_PREDICTIONS_DATA_COLLECTION);
};

export const onDataCollectionChange = (listener: () => void): (() => void) => {
  if (IS_CHROME) return () => {};
  const permissionsListener = () => listener();
  browser.permissions.onAdded.addListener(permissionsListener);
  browser.permissions.onRemoved.addListener(permissionsListener);
  return () => {
    browser.permissions.onAdded.removeListener(permissionsListener);
    browser.permissions.onRemoved.removeListener(permissionsListener);
  };
};
