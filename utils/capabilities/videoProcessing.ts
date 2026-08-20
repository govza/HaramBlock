import { IS_CHROME } from '@/utils/constants/environment';

const STORAGE_KEY = 'capability:videoProcessingAvailable';

/**
 * Video capture is broken on Firefox for Android: hardware-decoded frames live
 * behind an opaque surface whose readback returns empty pixels for every JS
 * capture API, and WebCodecs has no codecs registered. See ADR 0003.
 */
type PlatformOs = 'android' | 'cros' | 'fuchsia' | 'linux' | 'mac' | 'openbsd' | 'win';

export const isVideoProcessingSupported = (os: PlatformOs): boolean => os !== 'android';

/**
 * Resolve the capability once in the background and cache it in extension
 * storage so document-start content code and UI pages can read it without
 * a platform-info round-trip.
 */
export async function resolveVideoProcessingAvailable(): Promise<boolean> {
  if (IS_CHROME) return true;
  const { os } = await browser.runtime.getPlatformInfo();
  const available = isVideoProcessingSupported(os);
  await browser.storage.local.set({ [STORAGE_KEY]: available });
  return available;
}

/**
 * Read the cached capability. Defaults to true when the cache does not exist
 * yet (very first run before the background resolves it) - that interval is
 * accepted per ADR 0003.
 */
export async function getVideoProcessingAvailable(): Promise<boolean> {
  if (IS_CHROME) return true;
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] !== false;
}
