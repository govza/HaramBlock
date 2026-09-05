import { describe, expect, it } from 'vitest';

import {
  ANOMALY_FPS_RATIO,
  ANOMALY_LONG_TASK_MS,
  ANOMALY_RATE_LIMIT_MS,
  DvrAnomalyDetector,
  DvrTickRing,
} from '@/entrypoints/content/video/dvr/probeCore';

describe('DvrAnomalyDetector', () => {
  it('fires fps_drop only when presented trails captured over two consecutive windows', () => {
    const detector = new DvrAnomalyDetector();
    expect(detector.observeWindow({ captured: 60, presented: 30, nowMs: 1000 })).toBeNull();
    expect(detector.observeWindow({ captured: 60, presented: 30, nowMs: 2000 })).toBe('fps_drop');
  });

  it('does not fire when the ratio recovers between windows', () => {
    const detector = new DvrAnomalyDetector();
    expect(detector.observeWindow({ captured: 60, presented: 30, nowMs: 1000 })).toBeNull();
    expect(detector.observeWindow({ captured: 60, presented: 60 * ANOMALY_FPS_RATIO, nowMs: 2000 })).toBeNull();
    expect(detector.observeWindow({ captured: 60, presented: 30, nowMs: 3000 })).toBeNull();
  });

  it('ignores windows with no captures', () => {
    const detector = new DvrAnomalyDetector();
    expect(detector.observeWindow({ captured: 0, presented: 0, nowMs: 1000 })).toBeNull();
    expect(detector.observeWindow({ captured: 0, presented: 0, nowMs: 2000 })).toBeNull();
  });

  it('fires long_task above the threshold', () => {
    const detector = new DvrAnomalyDetector();
    expect(detector.observeLongTask(ANOMALY_LONG_TASK_MS, 1000)).toBeNull();
    expect(detector.observeLongTask(ANOMALY_LONG_TASK_MS + 1, 1000)).toBe('long_task');
  });

  it('rate limits dumps to one per window per session', () => {
    const detector = new DvrAnomalyDetector();
    expect(detector.signal('underrun', 1000)).toBe('underrun');
    expect(detector.signal('store_stall', 1000 + ANOMALY_RATE_LIMIT_MS - 1)).toBeNull();
    expect(detector.observeLongTask(500, 1000 + ANOMALY_RATE_LIMIT_MS - 1)).toBeNull();
    expect(detector.signal('store_stall', 1000 + ANOMALY_RATE_LIMIT_MS)).toBe('store_stall');
  });
});

describe('DvrTickRing', () => {
  it('keeps only the newest records once full and reuses record objects', () => {
    const ring = new DvrTickRing(3);
    for (let i = 0; i < 5; i++) {
      const record = ring.next();
      record.wallTs = i;
      record.mediaTime = i * 0.1;
    }
    expect(ring.snapshot().map(record => record.wallTs)).toEqual([2, 3, 4]);
    const first = ring.snapshot()[0];
    for (let i = 0; i < 3; i++) ring.next();
    expect(ring.snapshot()).toContain(first);
  });

  it('drops records older than the retention window', () => {
    const ring = new DvrTickRing(10);
    for (const wallTs of [0, 1000, 6000, 6500]) ring.next().wallTs = wallTs;
    expect(ring.snapshot(6500, 5000).map(record => record.wallTs)).toEqual([6000, 6500]);
  });
});
