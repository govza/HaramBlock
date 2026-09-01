import { describe, expect, it } from 'vitest';

import { RingLogSink } from '@/utils/telemetry/exporters/ringExporter';

import type { LogLevel, TelemetryLogRecord } from '@/utils/telemetry/records';

const record = (level: LogLevel, event: string): TelemetryLogRecord => ({
  timeMs: 0,
  level,
  scope: 'test',
  event,
  attributes: {},
  context: 'background',
});

describe('RingLogSink', () => {
  it('keeps only the newest records once the capacity is exceeded', () => {
    const ring = new RingLogSink(3, 'debug');
    for (let i = 0; i < 5; i++) ring.push(record('info', `e${i}`));

    expect(ring.snapshot().map(r => r.event)).toEqual(['e2', 'e3', 'e4']);
  });

  it('drops records below the minimum level', () => {
    const ring = new RingLogSink(10, 'warn');
    ring.push(record('debug', 'd'));
    ring.push(record('info', 'i'));
    ring.push(record('warn', 'w'));
    ring.push(record('error', 'e'));

    expect(ring.snapshot().map(r => r.event)).toEqual(['w', 'e']);
  });

  it('snapshot is a copy and clear empties the ring', () => {
    const ring = new RingLogSink(10, 'debug');
    ring.push(record('info', 'a'));
    const snapshot = ring.snapshot();
    ring.clear();

    expect(snapshot).toHaveLength(1);
    expect(ring.snapshot()).toHaveLength(0);
  });
});
