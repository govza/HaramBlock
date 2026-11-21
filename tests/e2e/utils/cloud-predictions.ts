import { CONSENT_STORAGE_KEY, REPORTER_ID_STORAGE_KEY } from '../../../utils/cloudPredictions/storageKeys.js';

/**
 * The slice of `storage.local` the steps need, reached as the page's own `browser` global inside
 * an extension page.
 */
interface ExtensionStorageApi {
  storage: {
    local: {
      get(keys: string[]): Promise<Record<string, unknown>>;
      remove(keys: string[]): Promise<void>;
    };
  };
}

/**
 * One cached image row as read straight from IndexedDB; only the report status matters here.
 */
export interface CachedImageRow {
  src: string;
  reportStatus?: string;
}

const openExtensionPageIfNeeded = async (): Promise<void> => {
  const extensionPath = await browser.getExtensionPath();
  const currentUrl = await browser.getUrl().catch(() => '');
  if (!currentUrl.startsWith(extensionPath)) {
    await browser.url(`${extensionPath}/popup.html`);
  }
};

const callExtensionStorage = async (method: 'get' | 'remove', keys: string[]): Promise<Record<string, unknown>> => {
  await openExtensionPageIfNeeded();
  const outcome = await browser.executeAsync(
    (
      storageMethod: 'get' | 'remove',
      storageKeys: string[],
      done: (outcome: { stored?: Record<string, unknown>; failure?: string }) => void,
    ) => {
      const { storage } = (globalThis as unknown as { browser: ExtensionStorageApi }).browser;
      storage.local[storageMethod](storageKeys).then(
        stored => done({ stored: stored ?? {} }),
        (error: Error) => done({ failure: error.message }),
      );
    },
    method,
    keys,
  );
  if (outcome.failure) throw new Error(`Extension storage ${method} failed — ${outcome.failure}`);
  return outcome.stored ?? {};
};

export const resetCloudPredictionsConsent = async (): Promise<void> => {
  await callExtensionStorage('remove', [CONSENT_STORAGE_KEY, REPORTER_ID_STORAGE_KEY]);
};

export const readStoredConsent = async (): Promise<string> => {
  const stored = await callExtensionStorage('get', [CONSENT_STORAGE_KEY]);
  const consent = stored[CONSENT_STORAGE_KEY];
  return typeof consent === 'string' ? consent : 'unanswered';
};

export const readCachedImageRows = async (): Promise<CachedImageRow[]> => {
  await openExtensionPageIfNeeded();
  return browser.executeAsync((done: (rows: CachedImageRow[]) => void) => {
    const request = globalThis.indexedDB.open('MediaCacheDatabase');
    request.onerror = () => done([]);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('imagePredictions')) {
        db.close();
        done([]);
        return;
      }
      const read = db.transaction('imagePredictions', 'readonly').objectStore('imagePredictions').getAll();
      read.onsuccess = () => {
        db.close();
        done((read.result as CachedImageRow[]).map(({ src, reportStatus }) => ({ src, reportStatus })));
      };
      read.onerror = () => {
        db.close();
        done([]);
      };
    };
  });
};
