import { describe, expect, it } from 'vitest';

import {
  DVR_CAPTURE_MAX_HEIGHT,
  DVR_CAPTURE_MIN_WIDTH,
  dvrCaptureScale,
} from '@/entrypoints/content/video/dvr/captureScale';

const base = {
  nativeWidth: 1920,
  nativeHeight: 1080,
  displayWidth: 1920,
  captureIntervalSec: 1 / 15,
  maxBytes: 64 * 1024 * 1024,
};

describe('dvrCaptureScale', () => {
  it('captures near full resolution when D is small (covered range)', () => {
    // D=0.3s: ~20 frames to hold; plenty of byte budget per frame.
    const scale = dvrCaptureScale({ ...base, delaySec: 0.3 });
    expect(scale * base.nativeWidth).toBeGreaterThan(1200);
  });

  it('degrades resolution rather than shrinking the ring below D', () => {
    // D=4s: many frames to hold; per-frame budget shrinks, so must the frames.
    const small = dvrCaptureScale({ ...base, delaySec: 4 });
    const large = dvrCaptureScale({ ...base, delaySec: 0.3 });
    expect(small).toBeLessThan(large);
  });

  it('never captures below the legacy 640px floor', () => {
    const scale = dvrCaptureScale({ ...base, delaySec: 100 });
    expect(scale * base.nativeWidth).toBeGreaterThanOrEqual(DVR_CAPTURE_MIN_WIDTH);
  });

  it('caps at the display size: pixels the viewer cannot see are wasted bytes', () => {
    const scale = dvrCaptureScale({ ...base, displayWidth: 960, delaySec: 0.3 });
    expect(scale * base.nativeWidth).toBeLessThanOrEqual(960);
  });

  it('caps 4K sources at 1080p', () => {
    const scale = dvrCaptureScale({
      ...base,
      nativeWidth: 3840,
      nativeHeight: 2160,
      displayWidth: 3840,
      delaySec: 0.3,
    });
    expect(scale * 2160).toBeLessThanOrEqual(DVR_CAPTURE_MAX_HEIGHT);
  });

  it('never upscales', () => {
    const scale = dvrCaptureScale({ ...base, nativeWidth: 320, nativeHeight: 180, delaySec: 0.3 });
    expect(scale).toBe(1);
  });

  it('waives the display cap when the rendered size is unknown', () => {
    const scale = dvrCaptureScale({ ...base, displayWidth: 0, delaySec: 0.3 });
    expect(scale * base.nativeWidth).toBeGreaterThan(1200);
  });
});
