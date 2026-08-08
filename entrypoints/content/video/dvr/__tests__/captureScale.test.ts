import { describe, expect, it } from 'vitest';

import { DVR_CAPTURE_MIN_WIDTH, dvrCaptureScale } from '@/entrypoints/content/video/dvr/captureScale';

const base = {
  nativeWidth: 1920,
  nativeHeight: 1080,
  displayWidth: 1920,
  maxWidth: 640,
  captureIntervalSec: 1 / 15,
  maxBytes: 64 * 1024 * 1024,
};

describe('dvrCaptureScale', () => {
  it('captures at the ladder ceiling when D is small (covered range)', () => {
    // D=0.3s: ~20 frames to hold; plenty of byte budget per frame.
    const scale = dvrCaptureScale({ ...base, delaySec: 0.3 });
    expect(scale * base.nativeWidth).toBe(base.maxWidth);
  });

  it('never captures below the 640px floor even under extreme D', () => {
    const scale = dvrCaptureScale({ ...base, delaySec: 100 });
    expect(scale * base.nativeWidth).toBeGreaterThanOrEqual(DVR_CAPTURE_MIN_WIDTH);
  });

  it('a degraded ladder ceiling lowers the floor with it', () => {
    const scale = dvrCaptureScale({ ...base, maxWidth: 320, delaySec: 0.3 });
    expect(scale * base.nativeWidth).toBe(320);
  });

  it('caps at the display size: pixels the viewer cannot see are wasted bytes', () => {
    const scale = dvrCaptureScale({ ...base, displayWidth: 480, delaySec: 0.3 });
    expect(scale * base.nativeWidth).toBeLessThanOrEqual(480);
  });

  it('never upscales', () => {
    const scale = dvrCaptureScale({ ...base, nativeWidth: 320, nativeHeight: 180, delaySec: 0.3 });
    expect(scale).toBe(1);
  });

  it('waives the display cap when the rendered size is unknown', () => {
    const scale = dvrCaptureScale({ ...base, displayWidth: 0, delaySec: 0.3 });
    expect(scale * base.nativeWidth).toBe(base.maxWidth);
  });
});
