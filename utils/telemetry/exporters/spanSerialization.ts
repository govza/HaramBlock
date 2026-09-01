import {
  ExportResultCode,
  hrTimeDuration,
  hrTimeToMilliseconds,
  millisToHrTime,
  type ExportResult,
} from '@opentelemetry/core';

import { sanitizeAttributes } from '@/utils/telemetry/attributes';

import type { HbContext } from '@/utils/telemetry/config';
import type { TelemetryForwarder } from '@/utils/telemetry/exporters/forwarding';
import type { SerializedSpan } from '@/utils/telemetry/records';
import type { Resource } from '@opentelemetry/resources';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

export function serializeSpan(span: ReadableSpan, hbContext: HbContext): SerializedSpan {
  const spanContext = span.spanContext();
  return {
    name: span.name,
    kind: span.kind,
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    traceFlags: spanContext.traceFlags,
    startTimeMs: hrTimeToMilliseconds(span.startTime),
    endTimeMs: hrTimeToMilliseconds(span.endTime),
    statusCode: span.status.code,
    statusMessage: span.status.message,
    attributes: sanitizeAttributes(span.attributes),
    links: span.links.map(link => ({
      traceId: link.context.traceId,
      spanId: link.context.spanId,
      attributes: link.attributes ? sanitizeAttributes(link.attributes) : undefined,
    })),
    events: span.events.map(event => ({
      name: event.name,
      timeMs: hrTimeToMilliseconds(event.time),
      attributes: event.attributes ? sanitizeAttributes(event.attributes) : undefined,
    })),
    scope: span.instrumentationScope.name,
    context: hbContext,
  };
}

export function deserializeSpan(serialized: SerializedSpan, resource: Resource): ReadableSpan {
  const startTime = millisToHrTime(serialized.startTimeMs);
  const endTime = millisToHrTime(serialized.endTimeMs);
  const spanContext = { traceId: serialized.traceId, spanId: serialized.spanId, traceFlags: serialized.traceFlags };
  return {
    name: serialized.name,
    kind: serialized.kind,
    spanContext: () => spanContext,
    parentSpanContext: serialized.parentSpanId
      ? { traceId: serialized.traceId, spanId: serialized.parentSpanId, traceFlags: serialized.traceFlags }
      : undefined,
    startTime,
    endTime,
    status: { code: serialized.statusCode, message: serialized.statusMessage },
    attributes: serialized.attributes,
    links: serialized.links.map(link => ({
      context: { traceId: link.traceId, spanId: link.spanId, traceFlags: serialized.traceFlags },
      attributes: link.attributes,
    })),
    events: serialized.events.map(event => ({
      name: event.name,
      time: millisToHrTime(event.timeMs),
      attributes: event.attributes,
    })),
    duration: hrTimeDuration(startTime, endTime),
    ended: true,
    resource,
    instrumentationScope: { name: serialized.scope },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

export class ForwardingSpanExporter implements SpanExporter {
  constructor(
    private readonly forwarder: TelemetryForwarder,
    private readonly hbContext: HbContext,
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.forwarder.pushSpans(spans.map(span => serializeSpan(span, this.hbContext)));
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  shutdown(): Promise<void> {
    return this.forwarder.flush();
  }

  forceFlush(): Promise<void> {
    return this.forwarder.flush();
  }
}
