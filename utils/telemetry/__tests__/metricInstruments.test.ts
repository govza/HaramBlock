import { describe, expect, it, vi } from 'vitest';

import { MetricInstruments } from '@/utils/telemetry/exporters/metricInstruments';

import type { Meter } from '@opentelemetry/api';

function makeMeter() {
  const counter = { add: vi.fn() };
  const histogram = { record: vi.fn() };
  const gauge = { addCallback: vi.fn() };
  const createCounter = vi.fn(() => counter);
  const meter = {
    createCounter,
    createHistogram: vi.fn(() => histogram),
    createObservableGauge: vi.fn(() => gauge),
  } as unknown as Meter;
  return { meter, createCounter, counter, histogram, gauge };
}

describe('MetricInstruments', () => {
  it('adds counter records to one monotonic counter per name', () => {
    const { meter, createCounter, counter } = makeMeter();
    const instruments = new MetricInstruments(meter);
    const attributes = { 'hb.dvr.store': 'raw' };
    instruments.record({ timeMs: 0, kind: 'counter', name: 'hb.dvr.frames_dropped', value: 3, attributes });
    instruments.record({ timeMs: 1, kind: 'counter', name: 'hb.dvr.frames_dropped', value: 2, attributes });
    expect(createCounter).toHaveBeenCalledTimes(1);
    expect(createCounter).toHaveBeenCalledWith('hb.dvr.frames_dropped');
    expect(counter.add.mock.calls).toEqual([
      [3, attributes],
      [2, attributes],
    ]);
  });

  it('keeps histogram and gauge records on their own instruments', () => {
    const { meter, counter, histogram, gauge } = makeMeter();
    const instruments = new MetricInstruments(meter);
    instruments.record({ timeMs: 0, kind: 'histogram', name: 'hb.dvr.warmup_ms', value: 40, attributes: {} });
    instruments.record({ timeMs: 0, kind: 'gauge', name: 'hb.dvr.playback_active', value: 1, attributes: {} });
    expect(histogram.record).toHaveBeenCalledWith(40, {});
    expect(gauge.addCallback).toHaveBeenCalledTimes(1);
    expect(counter.add).not.toHaveBeenCalled();
  });
});
