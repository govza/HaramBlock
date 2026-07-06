import { getLogSettings, onLogSettingsChange } from '@/utils/logging/logSettings';
import { OtlpExporter } from '@/utils/telemetry/otlpExporter';
import { newTraceId, toAttributes, msToNano, SEVERITY } from '@/utils/telemetry/otlpJson';
import { isLogRecordMessage, type ForwardedLogRecord } from '@/utils/telemetry/types';
import { wideEventToOtlp } from '@/utils/telemetry/wideEventToOtlp';

import type { WideEvent } from '@/utils/logging/types';

/**
 * Background-only telemetry orchestrator (dev builds only — callers gate on
 * import.meta.env.DEV and load this module dynamically so it never ships in prod).
 *
 * A background wide event reserves a traceId and waits up to MERGE_TIMEOUT_MS for its
 * content timing to arrive (mergeContentEvent). Merged events export the full
 * content+background trace; events that never merge (cached hits, video/GIF frames)
 * export background-only after the timeout. In-memory state is deliberately not
 * storage-backed: MV3 SW suspension loses at most a few seconds of dev telemetry.
 */

const MERGE_TIMEOUT_MS = 10_000;

interface PendingTrace {
  event: WideEvent;
  traceId: string;
  timer: ReturnType<typeof setTimeout>;
}

let exporter: OtlpExporter | null = null;
const pending = new Map<string, PendingTrace>();

const getVersion = (): string => {
  try {
    return browser.runtime.getManifest().version;
  } catch {
    return 'unknown';
  }
};

const createExporter = (endpoint: string): OtlpExporter =>
  new OtlpExporter({
    endpoint,
    resourceAttributes: toAttributes({
      'service.name': 'haramblock-extension',
      'service.version': getVersion(),
      'deployment.environment': 'development',
    }),
  });

const applySettings = (settings: { otlpEnabled: boolean; otlpEndpoint: string }): void => {
  if (!settings.otlpEnabled) {
    exporter?.dispose();
    exporter = null;
    return;
  }
  if (exporter) {
    exporter.dispose();
  }
  exporter = createExporter(settings.otlpEndpoint);
};

/** Reads settings, keeps the exporter in sync with the popup toggle, and receives
 * log records forwarded from content/popup contexts via runtime messages. */
export const initTelemetry = (): void => {
  void getLogSettings().then(applySettings);
  onLogSettingsChange(applySettings);
  browser.runtime.onMessage.addListener((message: unknown) => {
    if (isLogRecordMessage(message)) {
      telemetryOnLogRecord(message.record);
    }
    // Not our message or no response needed — let other listeners handle it
    return undefined;
  });
};

export const isTelemetryEnabled = (): boolean => exporter !== null;

const exportTrace = (event: WideEvent, traceId: string): void => {
  if (!exporter) return;
  const { spans, logRecord } = wideEventToOtlp(event, traceId);
  exporter.pushSpans(spans);
  exporter.pushLog(logRecord);
};

/** Background event arrived: reserve a traceId and wait for the content merge. */
export const telemetryOnBackgroundEvent = (event: WideEvent): void => {
  if (!exporter) return;

  // Same image re-requested while a trace is pending: export the old one as-is.
  const existing = pending.get(event.reqId);
  if (existing) {
    clearTimeout(existing.timer);
    exportTrace(existing.event, existing.traceId);
  }

  const traceId = newTraceId();
  const timer = setTimeout(() => {
    pending.delete(event.reqId);
    exportTrace(event, traceId);
  }, MERGE_TIMEOUT_MS);
  pending.set(event.reqId, { event, traceId, timer });
};

/** Content timing merged into a background event: export the complete trace. */
export const telemetryOnMergedEvent = (merged: WideEvent): void => {
  if (!exporter) return;
  const entry = pending.get(merged.reqId);
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(merged.reqId);
  }
  // No pending entry: SW restarted or the merge outlived the timeout — fresh trace
  exportTrace(merged, entry?.traceId ?? newTraceId());
};

/** Content event with no matching background event: export as its own trace. */
export const telemetryOnContentOnlyEvent = (event: WideEvent): void => {
  if (!exporter) return;
  exportTrace(event, newTraceId());
};

/** consola record (any context, forwarded via RPC for content/popup) → OTLP log. */
export const telemetryOnLogRecord = (record: ForwardedLogRecord): void => {
  if (!exporter) return;
  exporter.pushLog({
    timeUnixNano: msToNano(record.timeMs),
    severityNumber: SEVERITY[record.level],
    severityText: record.level.toUpperCase(),
    body: { stringValue: record.message },
    attributes: toAttributes({ 'log.tag': record.tag, 'extension.context': record.context }),
  });
};
