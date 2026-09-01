import type { LogLevel, TelemetryLogRecord } from '@/utils/telemetry/records';

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '#9b59b6',
  info: '#3498db',
  warn: '#f39c12',
  error: '#e74c3c',
};

const LEVEL_WRITERS: Record<LogLevel, (...args: unknown[]) => void> = {
  // eslint-disable-next-line no-console
  debug: (...args) => console.debug(...args),
  // eslint-disable-next-line no-console
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

function labelFor(record: TelemetryLogRecord): string {
  return `hb:${record.scope}`;
}

function styleFor(level: LogLevel): string {
  return `background: ${LEVEL_COLORS[level]}; border-radius: 0.5em; color: white; font-weight: bold; padding: 2px 0.5em;`;
}

export function printLogRecord(record: TelemetryLogRecord): void {
  const args: unknown[] = [`%c${labelFor(record)}%c ${record.event}`, styleFor(record.level), ''];
  if (Object.keys(record.attributes).length > 0) args.push(record.attributes);
  if (record.traceId) args.push(`trace=${record.traceId.slice(0, 8)}`);
  LEVEL_WRITERS[record.level](...args);
}

export const consoleLogSink = (record: TelemetryLogRecord): void => printLogRecord(record);
