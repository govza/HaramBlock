import { describe, expect, it } from 'vitest';

import { routesVideos, runsVideoInference } from '@/entrypoints/content/core/mediaRouting';

import type { IHostPolicy, PolicyBehavior } from '@/utils/types';

const policy = (behavior: PolicyBehavior, video = true): IHostPolicy => ({
  behavior,
  targets: { image: true, gif: true, video },
});

describe('routesVideos', () => {
  it('never routes videos when video processing is unavailable, blacklist included', () => {
    expect(routesVideos(policy('process'), false)).toBe(false);
    expect(routesVideos(policy('blacklist'), false)).toBe(false);
  });

  it('keeps current behavior when video processing is available', () => {
    expect(routesVideos(policy('process'), true)).toBe(true);
    expect(routesVideos(policy('blacklist'), true)).toBe(true);
    expect(routesVideos(policy('process', false), true)).toBe(false);
    expect(routesVideos(policy('whitelist'), true)).toBe(false);
  });
});

describe('runsVideoInference', () => {
  it('never runs inference when video processing is unavailable', () => {
    expect(runsVideoInference(policy('process'), false)).toBe(false);
  });

  it('keeps current behavior when video processing is available', () => {
    expect(runsVideoInference(policy('process'), true)).toBe(true);
    expect(runsVideoInference(policy('blacklist'), true)).toBe(false);
    expect(runsVideoInference(policy('process', false), true)).toBe(false);
  });
});
