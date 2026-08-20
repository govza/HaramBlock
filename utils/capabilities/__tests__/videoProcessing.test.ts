import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

vi.mock('@/utils/constants/environment', () => ({ IS_CHROME: false }));

import {
  getVideoProcessingAvailable,
  isVideoProcessingSupported,
  resolveVideoProcessingAvailable,
} from '@/utils/capabilities/videoProcessing';

const stubPlatform = (os: string) => {
  fakeBrowser.runtime.getPlatformInfo = vi.fn().mockResolvedValue({ os });
};

describe('video processing capability (Firefox build)', () => {
  beforeEach(() => fakeBrowser.reset());

  it('is withdrawn on Android and cached for later reads', async () => {
    stubPlatform('android');
    await expect(resolveVideoProcessingAvailable()).resolves.toBe(false);
    await expect(getVideoProcessingAvailable()).resolves.toBe(false);
  });

  it('is available on desktop and cached for later reads', async () => {
    stubPlatform('win');
    await expect(resolveVideoProcessingAvailable()).resolves.toBe(true);
    await expect(getVideoProcessingAvailable()).resolves.toBe(true);
  });

  it('defaults to available before the background has resolved the cache', async () => {
    await expect(getVideoProcessingAvailable()).resolves.toBe(true);
  });

  it('keys the withdrawal on the android OS only', () => {
    expect(isVideoProcessingSupported('android')).toBe(false);
    for (const os of ['win', 'mac', 'linux'] as const) expect(isVideoProcessingSupported(os)).toBe(true);
  });
});
