import { context, trace } from '@opentelemetry/api';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { StackContextManager } from '@opentelemetry/sdk-trace-web';

import { EXPORT_BATCH_DELAY_MS, type HbContext } from '@/utils/telemetry/config';
import { consoleLogSink } from '@/utils/telemetry/exporters/consoleExporter';
import { TelemetryForwarder, type SendBatch } from '@/utils/telemetry/exporters/forwarding';
import { ForwardingSpanExporter } from '@/utils/telemetry/exporters/spanSerialization';
import { registerLogSink, setLogContext } from '@/utils/telemetry/logger';
import { createResource } from '@/utils/telemetry/resource';

import type { TelemetryLogRecord } from '@/utils/telemetry/records';

declare const __HB_TELEMETRY_ENABLED__: boolean;

const isWarnOrAbove = (record: TelemetryLogRecord): boolean => record.level === 'warn' || record.level === 'error';

export function initClientTelemetry(hbContext: HbContext, send: SendBatch): void {
  setLogContext(hbContext);
  const forwarder = new TelemetryForwarder(hbContext, send);

  if (import.meta.env.DEV) registerLogSink(consoleLogSink);

  if (!__HB_TELEMETRY_ENABLED__) {
    registerLogSink(record => {
      if (isWarnOrAbove(record)) forwarder.pushLog(record);
    });
    return;
  }

  registerLogSink(forwarder.pushLog);

  const provider = new BasicTracerProvider({
    resource: createResource(hbContext),
    spanProcessors: [
      new BatchSpanProcessor(new ForwardingSpanExporter(forwarder, hbContext), {
        scheduledDelayMillis: EXPORT_BATCH_DELAY_MS,
      }),
    ],
  });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new StackContextManager().enable());
}
