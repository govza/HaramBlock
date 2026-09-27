import { formatCapturedLogs } from './console-capture.js';
import { Selectors } from '../constants/index.js';

const MEDIA_CACHE_DATABASE = 'MediaCacheDatabase';
const MEDIA_CACHE_STORES = ['imagePredictions', 'videoPredictions'];

export const clearMediaCache = async (): Promise<void> => {
  const extensionPath = await browser.getExtensionPath();
  await browser.url(`${extensionPath}/popup.html`);
  const failure = await browser.executeAsync(
    (databaseName: string, storeNames: string[], done: (failure: string | null) => void) => {
      const request = globalThis.indexedDB.open(databaseName);
      request.onerror = () => done(`open failed: ${request.error?.message ?? 'unknown'}`);
      request.onsuccess = () => {
        const db = request.result;
        const existingStores = storeNames.filter(name => db.objectStoreNames.contains(name));
        if (existingStores.length === 0) {
          db.close();
          done(null);
          return;
        }
        const transaction = db.transaction(existingStores, 'readwrite');
        for (const name of existingStores) transaction.objectStore(name).clear();
        transaction.oncomplete = () => {
          db.close();
          done(null);
        };
        transaction.onerror = () => done(`clear failed: ${transaction.error?.message ?? 'unknown'}`);
      };
    },
    MEDIA_CACHE_DATABASE,
    MEDIA_CACHE_STORES,
  );
  if (failure) throw new Error(`Failed to clear the media cache — ${failure}`);
};

interface VideoDiagnostics {
  present: boolean;
  haramblockAttributes: Record<string, string>;
  readyState?: number;
  paused?: boolean;
  currentTime?: number;
  networkState?: number;
  mediaError?: string | null;
  inlineOpacity?: string;
  classes?: string;
  contentScriptInjected: boolean;
}

export const collectVideoDiagnostics = async (): Promise<VideoDiagnostics> =>
  browser.execute((videoSelector: string) => {
    const doc = globalThis.document;
    const contentScriptInjected = doc.getElementById('haramblock-prediction-styles') !== null;
    const video = doc.querySelector<HTMLVideoElement>(videoSelector);
    if (!video) return { present: false, haramblockAttributes: {}, contentScriptInjected };
    const haramblockAttributes: Record<string, string> = {};
    for (const { name, value } of Array.from(video.attributes)) {
      if (name.startsWith('data-haramblock')) haramblockAttributes[name] = value;
    }
    return {
      present: true,
      haramblockAttributes,
      readyState: video.readyState,
      paused: video.paused,
      currentTime: Math.round(video.currentTime * 100) / 100,
      networkState: video.networkState,
      mediaError: video.error ? `${video.error.code}: ${video.error.message}` : null,
      inlineOpacity: video.style.opacity,
      classes: video.className,
      contentScriptInjected,
    };
  }, Selectors.TEST_VIDEO);

export const describeVideoState = async (): Promise<string> => {
  const diagnostics = await collectVideoDiagnostics().catch((err: Error) => `unavailable (${err.message})`);
  return `video: ${JSON.stringify(diagnostics)}; HaramBlock logs: ${formatCapturedLogs(10)}`;
};

export const waitWithVideoDiagnostics = async (
  condition: () => Promise<boolean>,
  options: { timeout: number; failureMessage: string },
): Promise<void> => {
  try {
    await browser.waitUntil(condition, { timeout: options.timeout, timeoutMsg: options.failureMessage });
  } catch (err) {
    throw new Error(`${(err as Error).message} — ${await describeVideoState()}`);
  }
};
