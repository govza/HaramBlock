import type { TelemetryMetricRecord } from '@/utils/telemetry/records';
import type { Attributes, Counter, Histogram, Meter, ObservableGauge } from '@opentelemetry/api';

export const GAUGE_STALE_AFTER_MS = 5000;

interface GaugeSample {
  value: number;
  attributes: Attributes;
  seenAt: number;
}

interface GaugeEntry {
  instrument: ObservableGauge;
  samples: Map<string, GaugeSample>;
}

const attributeKey = (attributes: Attributes): string => JSON.stringify(Object.entries(attributes).sort());

export class MetricInstruments {
  private readonly gauges = new Map<string, GaugeEntry>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly counters = new Map<string, Counter>();

  constructor(
    private readonly meter: Meter,
    private readonly now: () => number = Date.now,
  ) {}

  record(record: TelemetryMetricRecord): void {
    if (record.kind === 'histogram') {
      this.histogram(record.name).record(record.value, record.attributes);
      return;
    }
    if (record.kind === 'counter') {
      this.counter(record.name).add(record.value, record.attributes);
      return;
    }
    this.gaugeSamples(record.name).set(attributeKey(record.attributes), {
      value: record.value,
      attributes: record.attributes,
      seenAt: this.now(),
    });
  }

  private histogram(name: string): Histogram {
    let instrument = this.histograms.get(name);
    if (!instrument) {
      instrument = this.meter.createHistogram(name);
      this.histograms.set(name, instrument);
    }
    return instrument;
  }

  private counter(name: string): Counter {
    let instrument = this.counters.get(name);
    if (!instrument) {
      instrument = this.meter.createCounter(name);
      this.counters.set(name, instrument);
    }
    return instrument;
  }

  private gaugeSamples(name: string): Map<string, GaugeSample> {
    let entry = this.gauges.get(name);
    if (!entry) {
      const samples = new Map<string, GaugeSample>();
      const instrument = this.meter.createObservableGauge(name);
      instrument.addCallback(result => {
        const staleBefore = this.now() - GAUGE_STALE_AFTER_MS;
        for (const [key, sample] of samples) {
          if (sample.seenAt < staleBefore) {
            samples.delete(key);
            continue;
          }
          result.observe(sample.value, sample.attributes);
        }
      });
      entry = { instrument, samples };
      this.gauges.set(name, entry);
    }
    return entry.samples;
  }
}
