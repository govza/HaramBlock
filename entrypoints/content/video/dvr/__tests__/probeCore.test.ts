import { describe, expect, it } from 'vitest';

import {
  ANOMALY_FPS_WINDOWS,
  ANOMALY_LONG_TASK_MS,
  ANOMALY_RATE_LIMIT_MS,
  ANOMALY_WARMUP_WINDOWS,
  BACKSTEP_SEEK_FRAMES,
  backstepBucket,
  DvrAnomalyDetector,
  DvrTickRing,
  SourceClock,
} from '@/entrypoints/content/video/dvr/probeCore';

const warmedDetector = (): DvrAnomalyDetector => {
  const detector = new DvrAnomalyDetector();
  for (let i = 0; i < ANOMALY_WARMUP_WINDOWS; i++) {
    detector.observeWindow({ captured: 60, presented: 60, nowMs: -1000 * (ANOMALY_WARMUP_WINDOWS - i) });
  }
  return detector;
};

describe('DvrAnomalyDetector', () => {
  it('fires fps_drop only when presented trails captured over two consecutive windows', () => {
    const detector = warmedDetector();
    expect(detector.observeWindow({ captured: 60, presented: 30, nowMs: 1000 })).toBeNull();
    expect(detector.observeWindow({ captured: 60, presented: 30, nowMs: 2000 })).toBe('fps_drop');
  });

  it('ignores the warm-up windows right after a run starts, where the presenter is still filling', () => {
    const detector = new DvrAnomalyDetector();
    for (let i = 0; i < ANOMALY_WARMUP_WINDOWS + ANOMALY_FPS_WINDOWS - 1; i++) {
      expect(detector.observeWindow({ captured: 60, presented: 10, nowMs: 1000 * (i + 1) })).toBeNull();
    }
    const nowMs = 1000 * (ANOMALY_WARMUP_WINDOWS + ANOMALY_FPS_WINDOWS);
    expect(detector.observeWindow({ captured: 60, presented: 10, nowMs })).toBe('fps_drop');
  });

  it('re-enters warm-up after playback goes inactive', () => {
    const detector = warmedDetector();
    detector.resetWindows();
    for (let i = 0; i < ANOMALY_WARMUP_WINDOWS + ANOMALY_FPS_WINDOWS - 1; i++) {
      expect(detector.observeWindow({ captured: 60, presented: 10, nowMs: 1000 * (i + 1) })).toBeNull();
    }
    const nowMs = 1000 * (ANOMALY_WARMUP_WINDOWS + ANOMALY_FPS_WINDOWS);
    expect(detector.observeWindow({ captured: 60, presented: 10, nowMs })).toBe('fps_drop');
  });

  it('judges the aggregate over the 2 s window, not each 1 s slice', () => {
    const detector = warmedDetector();
    expect(detector.observeWindow({ captured: 60, presented: 30, nowMs: 1000 })).toBeNull();
    expect(detector.observeWindow({ captured: 60, presented: 60, nowMs: 2000 })).toBeNull();
    expect(detector.observeWindow({ captured: 60, presented: 42, nowMs: 3000 })).toBeNull();
    expect(detector.observeWindow({ captured: 60, presented: 40, nowMs: 4000 })).toBe('fps_drop');
  });

  it('ignores windows with no captures', () => {
    const detector = warmedDetector();
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
    expect(seek.backstep).toBe('seek');
    expect(clock.estimatedFps()).toBe(0);
    expect(clock.observe(0.5333, 120).framesSkipped).toBe(0);
    expect(clock.estimatedFps()).toBeCloseTo(30, 0);
  });

  it('sizes a backwards delivery in frame intervals (Firefox rVFC re-delivering an older frame)', () => {
    const clock = new SourceClock();
    clock.observe(1.0, 0);
    clock.observe(1.04, 40);
    clock.observe(1.08, 80);
    expect(clock.observe(1.04, 120).backstep).toBe('1');
    expect(clock.observe(1.0, 0).backstep).toBe('seek');
    expect(clock.observe(1.04, 40).backstep).toBeNull();
    expect(clock.observe(1.08, 80).backstep).toBeNull();
    expect(clock.observe(1.0, 120).backstep).toBe('2');
  });
});

describe('backstepBucket', () => {
  it('buckets by whole frame intervals and treats anything past the seek bound or an unknown interval as a seek', () => {
    expect(backstepBucket(-0.04, 0.04)).toBe('1');
    expect(backstepBucket(-0.0417, 0.0417)).toBe('1');
    expect(backstepBucket(-0.08, 0.04)).toBe('2');
    expect(backstepBucket(-0.12, 0.04)).toBe('3+');
    expect(backstepBucket(-0.04 * BACKSTEP_SEEK_FRAMES, 0.04)).toBe('3+');
    expect(backstepBucket(-0.04 * (BACKSTEP_SEEK_FRAMES + 1), 0.04)).toBe('seek');
    expect(backstepBucket(-0.04, Number.POSITIVE_INFINITY)).toBe('seek');
  });
});
