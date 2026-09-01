import { LOG_LEVEL_RANK, type LogLevel, type TelemetryLogRecord } from '@/utils/telemetry/records';

export class RingLogSink {
  private readonly records: TelemetryLogRecord[] = [];
  private readonly minRank: number;

  constructor(
    private readonly capacity: number,
    minLevel: LogLevel,
  ) {
    this.minRank = LOG_LEVEL_RANK[minLevel];
  }

  push = (record: TelemetryLogRecord): void => {
    if (LOG_LEVEL_RANK[record.level] < this.minRank) return;
    this.records.push(record);
    if (this.records.length > this.capacity) {
      this.records.splice(0, this.records.length - this.capacity);
    }
  };

  snapshot(): TelemetryLogRecord[] {
    return [...this.records];
  }

  clear(): void {
    this.records.length = 0;
  }
}
