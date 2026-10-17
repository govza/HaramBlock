import { IS_CHROME } from '@/utils/constants/environment';

const STORAGE_KEY = 'capability:videoCapability';

/**
 * How much of the video pipeline a platform supports. `lookahead-only`: page pixels of a video are
 * unreadable (Firefox for Android hands JS empty frames, ADR 0003), so only Lookahead Analysis runs
 * and every gap in its coverage fails open (ADR 0005).
 */
export type VideoCapability = 'full' | 'lookahead-only';

type PlatformOs = 'android' | 'cros' | 'fuchsia' | 'linux' | 'mac' | 'openbsd' | 'win';

export const videoCapabilityOf = (os: PlatformOs): VideoCapability => (os === 'android' ? 'lookahead-only' : 'full');

export const pagePixelsReadable = (capability: VideoCapability): boolean => capability === 'full';

/**
 * Resolve the capability once in the background and cache it in extension storage so
 * document-start content code and UI pages can read it without a platform-info round-trip.
 */
export async function resolveVideoCapability(): Promise<VideoCapability> {
  if (IS_CHROME) return 'full';
  const { os } = await browser.runtime.getPlatformInfo();
  const capability = videoCapabilityOf(os);
  await browser.storage.local.set({ [STORAGE_KEY]: capability });
  return capability;
}

/**
 * Read the cached capability. Before the background has resolved it on Firefox, assume
 * `lookahead-only`: it never presents a verdict for unread pixels.
 */
export async function getVideoCapability(): Promise<VideoCapability> {
  if (IS_CHROME) return 'full';
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] === 'full' ? 'full' : 'lookahead-only';
}
