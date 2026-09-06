import { describe, expect, it } from 'vitest';

import {
  DVR_CAPTURE_MIN_WIDTH,
  FIREFOX_RAW_CAPTURE_MAX_WIDTH,
  dvrCaptureScale,
  rawCaptureCeilingPx,
} from '@/entrypoints/content/video/dvr/captureScale';

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

  it('captures at the display size under the unbounded full tier when the budget allows', () => {
    const scale = dvrCaptureScale({
      ...base,
      maxWidth: Number.POSITIVE_INFINITY,
      maxBytes: 768 * 1024 * 1024,
      delaySec: 1.5,
    });
    // Display = native = 1920: full-resolution capture.
    expect(scale).toBe(1);
  });

  it('the byte budget still bounds an unbounded tier under a large D', () => {
    const scale = dvrCaptureScale({
      ...base,
      maxWidth: Number.POSITIVE_INFINITY,
      maxBytes: 128 * 1024 * 1024,
      delaySec: 4,
    });
    expect(scale).toBeLessThan(1);
    expect(scale * base.nativeWidth).toBeGreaterThanOrEqual(DVR_CAPTURE_MIN_WIDTH);
  });
});

describe('rawCaptureCeilingPx', () => {
  it('ceilings Firefox raw capture below the unbounded full tier', () => {
    expect(rawCaptureCeilingPx(true)).toBe(FIREFOX_RAW_CAPTURE_MAX_WIDTH);
    expect(rawCaptureCeilingPx(false)).toBe(Number.POSITIVE_INFINITY);
  });

  it('applied as the ladder ceiling, holds a 1080p Firefox capture at 960 px', () => {
    const scale = dvrCaptureScale({
      ...base,
      maxWidth: Math.min(Number.POSITIVE_INFINITY, rawCaptureCeilingPx(true)),
      maxBytes: 768 * 1024 * 1024,
      delaySec: 1.5,
    });
    expect(Math.round(1920 * scale)).toBe(FIREFOX_RAW_CAPTURE_MAX_WIDTH);
  });
});
