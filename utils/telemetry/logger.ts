import { context as otelContext, type Context } from '@opentelemetry/api';

import { sanitizeAttributes, type AttributeValue, type LooseAttributes } from '@/utils/telemetry/attributes';
import { spanIdsFromContext } from '@/utils/telemetry/propagation';

import type { HbContext } from '@/utils/telemetry/config';
import type { LogLevel, TelemetryLogRecord } from '@/utils/telemetry/records';

export type LogSink = (record: TelemetryLogRecord) => void;

export interface HbLogger {
  debug(event: string, attributes?: LooseAttributes, ctx?: Context): void;
  info(event: string, attributes?: LooseAttributes, ctx?: Context): void;
  warn(event: string, attributes?: LooseAttributes, ctx?: Context): void;
  error(event: string, attributes?: LooseAttributes, ctx?: Context): void;
}

let currentContext: HbContext = 'background';
const sinks = new Set<LogSink>();
const commonAttributes: Record<string, AttributeValue> = {};

export function setLogContext(hbContext: HbContext): void {
  currentContext = hbContext;
}

export function getLogContext(): HbContext {
  return currentContext;
}

export function registerLogSink(sink: LogSink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

export function setCommonAttributes(attributes: LooseAttributes): void {
  Object.assign(commonAttributes, sanitizeAttributes(attributes));
}

export function getCommonAttributes(): Record<string, AttributeValue> {
  return { ...commonAttributes };
}

function emit(scope: string, level: LogLevel, event: string, attributes?: LooseAttributes, ctx?: Context): void {
  if (sinks.size === 0) return;
  const record: TelemetryLogRecord = {
    timeMs: Date.now(),
    level,
    scope,
    event,
    attributes: { ...commonAttributes, ...sanitizeAttributes(attributes) },
    context: currentContext,
    ...spanIdsFromContext(ctx ?? otelContext.active()),
  };
  for (const sink of sinks) {
    try {
      sink(record);
    } catch {
      continue;
    }
  }
}

export function getLogger(scope: string): HbLogger {
  return {
    debug: (event, attributes, ctx) => emit(scope, 'debug', event, attributes, ctx),
    info: (event, attributes, ctx) => emit(scope, 'info', event, attributes, ctx),
    warn: (event, attributes, ctx) => emit(scope, 'warn', event, attributes, ctx),
    error: (event, attributes, ctx) => emit(scope, 'error', event, attributes, ctx),
  };
}
