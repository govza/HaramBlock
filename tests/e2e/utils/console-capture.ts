export interface LogEntry {
  level: string;
  text: string | null;
}

interface LogEntryAddedEvent {
  entry?: Partial<LogEntry>;
  level?: string;
  text?: string | null;
}

let capturedLogs: LogEntry[] = [];
let subscribed = false;

const normalizeLogEntry = (rawEntry: LogEntryAddedEvent): LogEntry | null => {
  const entry = rawEntry.entry ?? rawEntry;
  const text = typeof entry.text === 'string' ? entry.text : null;
  if (!text) {
    return null;
  }

  return {
    level: typeof entry.level === 'string' ? entry.level.toLowerCase() : 'info',
    text,
  };
};

export const startCapturingExtensionLogs = (): void => {
  capturedLogs = [];
  if (subscribed) return;
  browser.on('log.entryAdded', (rawEntry: LogEntryAddedEvent) => {
    const entry = normalizeLogEntry(rawEntry);
    if (entry?.text?.includes('HaramBlock')) {
      capturedLogs.push(entry);
    }
  });
  subscribed = true;
};

export const getCapturedLogs = (): readonly LogEntry[] => capturedLogs;

export const formatCapturedLogs = (limit = 3): string => {
  if (capturedLogs.length === 0) {
    return 'none';
  }

  return capturedLogs
    .slice(-limit)
    .map(({ level, text }) => `[${level}] ${text}`)
    .join(' | ');
};
