import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

vi.mock('@/utils/constants/environment', () => ({ IS_CHROME: false }));

import {
  getVideoCapability,
  pagePixelsReadable,
  resolveVideoCapability,
  videoCapabilityOf,
} from '@/utils/capabilities/videoCapability';

const stubPlatform = (os: string) => {
  fakeBrowser.runtime.getPlatformInfo = vi.fn().mockResolvedValue({ os });
};

describe('video capability (Firefox build)', () => {
  beforeEach(() => fakeBrowser.reset());

  it('is lookahead-only on Android and cached for later reads', async () => {
    stubPlatform('android');
    await expect(resolveVideoCapability()).resolves.toBe('lookahead-only');
    await expect(getVideoCapability()).resolves.toBe('lookahead-only');
  });

  it('is full on desktop and cached for later reads', async () => {
    stubPlatform('win');
    await expect(resolveVideoCapability()).resolves.toBe('full');
    await expect(getVideoCapability()).resolves.toBe('full');
  });

  it('assumes lookahead-only before the background has resolved the cache', async () => {
    await expect(getVideoCapability()).resolves.toBe('lookahead-only');
  });

  it('keys lookahead-only on the android OS only', () => {
    expect(videoCapabilityOf('android')).toBe('lookahead-only');
    for (const os of ['win', 'mac', 'linux'] as const) expect(videoCapabilityOf(os)).toBe('full');
  });

  it('reads page pixels only with the full capability', () => {
    expect(pagePixelsReadable('full')).toBe(true);
    expect(pagePixelsReadable('lookahead-only')).toBe(false);
  });
});
