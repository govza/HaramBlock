import { describe, expect, it } from 'vitest';

import { routesVideos, runsVideoInference } from '@/entrypoints/content/core/mediaRouting';

import type { IHostPolicy, PolicyBehavior } from '@/utils/types';

const policy = (behavior: PolicyBehavior, video = true): IHostPolicy => ({
  behavior,
  targets: { image: true, gif: true, video },
});

describe('routesVideos', () => {
  it('routes videos for blacklist and for process with the video target', () => {
    expect(routesVideos(policy('process'))).toBe(true);
    expect(routesVideos(policy('blacklist'))).toBe(true);
    expect(routesVideos(policy('process', false))).toBe(false);
    expect(routesVideos(policy('whitelist'))).toBe(false);
  });
});

describe('runsVideoInference', () => {
  it('runs inference only for process with the video target', () => {
    expect(runsVideoInference(policy('process'))).toBe(true);
    expect(runsVideoInference(policy('blacklist'))).toBe(false);
    expect(runsVideoInference(policy('process', false))).toBe(false);
  });
});
