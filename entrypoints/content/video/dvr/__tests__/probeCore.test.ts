import { describe, expect, it } from 'vitest';

import {
  ANOMALY_LONG_TASK_MS,
  ANOMALY_RATE_LIMIT_MS,
  DvrAnomalyDetector,
  DvrTickRing,
  SourceClock,
} from '@/entrypoints/content/video/dvr/probeCore';

describe('DvrAnomalyDetector', () => {
  it('fires fps_drop only when presented trails captured over two consecutive windows', () => {
    const detector = new DvrAnomalyDetector();
    expect(detector.observeWindow({ captured: 60, presented: 30, nowMs: 1000 })).toBeNull();
    expect(detector.observeWindow({ captured: 60, presented: 30, nowMs: 2000 })).toBe('fps_drop');
  });

  it('judges the aggregate over the 2 s window, not each 1 s slice', () => {
    const detector = new DvrAnomalyDetector();
    expect(detector.observeWindow({ captured: 60, presented: 30, nowMs: 1000 })).toBeNull();
    expect(detector.observeWindow({ captured: 60, presented: 60, nowMs: 2000 })).toBeNull();
    expect(detector.observeWindow({ captured: 60, presented: 42, nowMs: 3000 })).toBeNull();
    expect(detector.observeWindow({ captured: 60, presented: 40, nowMs: 4000 })).toBe('fps_drop');
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

describe('SourceClock', () => {
  it('counts a repeated mediaTime as a duplicate delivery without touching the frame interval', () => {
    const clock = new SourceClock();
    clock.observe(1.0, 0);
    clock.observe(1.04, 16);
    const duplicate = clock.observe(1.04, 32);
    expect(duplicate.kind).toBe('duplicate');
    expect(duplicate.wallGapMs).toBe(16);
    expect(clock.estimatedFps()).toBeCloseTo(25);
  });

  it('derives skipped source frames from a mediaTime jump beyond 1.5 intervals', () => {
    const clock = new SourceClock();
    clock.observe(1.0, 0);
    clock.observe(1.04, 40);
    const skipped = clock.observe(1.12, 80);
    expect(skipped.kind).toBe('new');
    expect(skipped.framesSkipped).toBe(1);
    expect(skipped.mediaDelta).toBeCloseTo(0.08);
  });

  it('flags a delivery as late when its wall gap exceeds 1.5 frame intervals', () => {
    const clock = new SourceClock();
    clock.observe(1.0, 0);
    clock.observe(1.04, 40);
    expect(clock.observe(1.08, 80).late).toBe(false);
    expect(clock.observe(1.12, 150).late).toBe(true);
  });

  it('treats a backwards mediaTime as a seek and re-learns the frame interval', () => {
    const clock = new SourceClock();
    clock.observe(1.0, 0);
    clock.observe(1.04, 40);
    const seek = clock.observe(0.5, 80);
    expect(seek.kind).toBe('seek');
    expect(clock.estimatedFps()).toBe(0);
    expect(clock.observe(0.5333, 120).framesSkipped).toBe(0);
    expect(clock.estimatedFps()).toBeCloseTo(30, 0);
  });
});
