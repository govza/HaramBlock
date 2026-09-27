import { ATTR, type AttributeValue } from '@/utils/telemetry/attributes';

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

const PLAIN_TEXT_LEVELS: ReadonlySet<LogLevel> = new Set(['warn', 'error']);

function labelFor(record: TelemetryLogRecord): string {
  return `hb:${record.scope}`;
}

function styleFor(level: LogLevel): string {
  return `background: ${LEVEL_COLORS[level]}; border-radius: 0.5em; color: white; font-weight: bold; padding: 2px 0.5em;`;
}

function formatValue(value: AttributeValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function formatPlainText(record: TelemetryLogRecord): string {
  const { [ATTR.errorStack]: stack, ...rest } = record.attributes;
  const pairs = Object.entries(rest).map(([key, value]) => `${key}=${formatValue(value)}`);
  if (record.traceId) pairs.push(`trace=${record.traceId.slice(0, 8)}`);
  const header = [`[${labelFor(record)}] ${record.event}`, ...pairs].join(' | ');
  return stack === undefined ? header : `${header}\n${formatValue(stack)}`;
}

export const consoleLogSink = (record: TelemetryLogRecord): void => {
  if (PLAIN_TEXT_LEVELS.has(record.level)) {
    LEVEL_WRITERS[record.level](formatPlainText(record));
    return;
  }
  const args: unknown[] = [`%c${labelFor(record)}%c ${record.event}`, styleFor(record.level), ''];
  if (Object.keys(record.attributes).length > 0) args.push(record.attributes);
  if (record.traceId) args.push(`trace=${record.traceId.slice(0, 8)}`);
  LEVEL_WRITERS[record.level](...args);
};
