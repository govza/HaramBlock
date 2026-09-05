import { context, metrics, trace, type Context } from '@opentelemetry/api';
import { logs, SeverityNumber, type Logger as OtelLogger } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BasicTracerProvider, BatchSpanProcessor, type ReadableSpan, type Span } from '@opentelemetry/sdk-trace-base';
import { StackContextManager } from '@opentelemetry/sdk-trace-web';

import { ATTR } from '@/utils/telemetry/attributes';
import {
  EXPORT_BATCH_DELAY_MS,
  IDLE_FLUSH_DELAY_MS,
  METRIC_EXPORT_INTERVAL_MS,
  OTEL_ENDPOINT,
  RING_CAPACITY,
  type HbContext,
} from '@/utils/telemetry/config';
import { consoleLogSink } from '@/utils/telemetry/exporters/consoleExporter';
import { MetricInstruments } from '@/utils/telemetry/exporters/metricInstruments';
import { RingLogSink } from '@/utils/telemetry/exporters/ringExporter';
import { deserializeSpan } from '@/utils/telemetry/exporters/spanSerialization';
import { getCommonAttributes, registerLogSink, setLogContext } from '@/utils/telemetry/logger';
import { registerMetricSink } from '@/utils/telemetry/metrics';
import { createResource, getExtensionVersion } from '@/utils/telemetry/resource';

import type { TelemetryBatch, TelemetryExport, TelemetryLogRecord } from '@/utils/telemetry/records';
import type { Resource } from '@opentelemetry/resources';

declare const __HB_TELEMETRY_ENABLED__: boolean;

const SEVERITY: Record<TelemetryLogRecord['level'], SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

interface SdkPipeline {
  loggerProvider: LoggerProvider;
  tracerProvider: BasicTracerProvider;
  meterProvider: MeterProvider;
  spanProcessor: BatchSpanProcessor;
  instruments: MetricInstruments;
  forwardedResources: Map<string, Resource>;
  loggers: Map<string, OtelLogger>;
}

let ring: RingLogSink | null = null;
let sdk: SdkPipeline | null = null;
let idleFlushTimer: ReturnType<typeof setTimeout> | null = null;

function contextFromRecord(record: TelemetryLogRecord): Context | undefined {
  if (!record.traceId || !record.spanId) return undefined;
  return trace.setSpanContext(context.active(), {
    traceId: record.traceId,
    spanId: record.spanId,
    traceFlags: 1,
    isRemote: true,
  });
}

function scheduleIdleFlush(): void {
  if (!sdk) return;
  if (idleFlushTimer) clearTimeout(idleFlushTimer);
  idleFlushTimer = setTimeout(() => {
    idleFlushTimer = null;
    void Promise.all([
      sdk?.loggerProvider.forceFlush(),
      sdk?.tracerProvider.forceFlush(),
      sdk?.meterProvider.forceFlush(),
    ]).catch(() => undefined);
  }, IDLE_FLUSH_DELAY_MS);
}

function emitToSdk(record: TelemetryLogRecord): void {
  if (!sdk) return;
  let logger = sdk.loggers.get(record.scope);
  if (!logger) {
    logger = sdk.loggerProvider.getLogger(record.scope);
    sdk.loggers.set(record.scope, logger);
  }
  logger.emit({
    eventName: record.event,
    body: record.event,
    timestamp: record.timeMs,
    severityNumber: SEVERITY[record.level],
    severityText: record.level,
    attributes: { ...record.attributes, [ATTR.context]: record.context },
    context: contextFromRecord(record),
  });
  scheduleIdleFlush();
}

function forwardedResource(hbContext: HbContext, tabId?: number): Resource {
  if (!sdk) throw new Error('telemetry sdk not initialised');
  const key = `${hbContext}:${tabId ?? ''}`;
  let resource = sdk.forwardedResources.get(key);
  if (!resource) {
    resource = createResource(hbContext, tabId);
    sdk.forwardedResources.set(key, resource);
  }
  return resource;
}

class CommonAttributesSpanProcessor {
  onStart(span: Span): void {
    span.setAttributes(getCommonAttributes());
  }
  onEnd(_span: ReadableSpan): void {
    scheduleIdleFlush();
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

function installSdk(): SdkPipeline {
  const resource = createResource('background');
  const spanProcessor = new BatchSpanProcessor(new OTLPTraceExporter({ url: `${OTEL_ENDPOINT}/v1/traces` }), {
    scheduledDelayMillis: EXPORT_BATCH_DELAY_MS,
  });
  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [new CommonAttributesSpanProcessor(), spanProcessor],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: `${OTEL_ENDPOINT}/v1/logs` }),
        scheduledDelayMillis: EXPORT_BATCH_DELAY_MS,
      }),
    ],
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${OTEL_ENDPOINT}/v1/metrics` }),
        exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS,
      }),
    ],
  });

  trace.setGlobalTracerProvider(tracerProvider);
  logs.setGlobalLoggerProvider(loggerProvider);
  metrics.setGlobalMeterProvider(meterProvider);
  context.setGlobalContextManager(new StackContextManager().enable());

  return {
    loggerProvider,
    tracerProvider,
    meterProvider,
    spanProcessor,
    instruments: new MetricInstruments(meterProvider.getMeter('haramblock')),
    forwardedResources: new Map(),
    loggers: new Map(),
  };
}

export function initBackgroundTelemetry(): void {
  setLogContext('background');
  ring = new RingLogSink(RING_CAPACITY, import.meta.env.DEV ? 'debug' : 'warn');
  registerLogSink(ring.push);
  if (import.meta.env.DEV) registerLogSink(consoleLogSink);

  if (!__HB_TELEMETRY_ENABLED__) return;

  sdk = installSdk();
  registerLogSink(record => emitToSdk(record));
  registerMetricSink(record => sdk?.instruments.record(record));
}

export function ingestForwardedTelemetry(batch: TelemetryBatch, tabId?: number): void {
  for (const record of batch.logs) {
    const stamped =
      tabId === undefined ? record : { ...record, attributes: { ...record.attributes, [ATTR.tabId]: tabId } };
    ring?.push(stamped);
    emitToSdk(stamped);
  }
  if (!sdk) return;
  for (const metric of batch.metrics ?? []) sdk.instruments.record(metric);
  if (batch.spans.length === 0) return;
  const resource = forwardedResource(batch.context, tabId);
  for (const serialized of batch.spans) {
    sdk.spanProcessor.onEnd(deserializeSpan(serialized, resource));
  }
  scheduleIdleFlush();
}

export function getRingRecords(): TelemetryLogRecord[] {
  return ring?.snapshot() ?? [];
}

export function exportTelemetry(): TelemetryExport {
  const records = getRingRecords();
  return {
    exportedAt: Date.now(),
    version: getExtensionVersion(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    recordCount: records.length,
    records,
  };
}
