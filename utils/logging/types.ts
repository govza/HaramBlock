export type EventStatus = 'success' | 'error' | 'skipped' | 'cached';
export type EventContext = 'content' | 'background';

export interface WideEvent {
  reqId: string;
  src: string;
  hostname: string;
  context: EventContext;
  timestamp: number;

  // Timing fields (background uses queueMs/fetchMs/decodeMs/inferenceMs/e2eMs, content uses sendMs/waitMs/styleMs)
  totalMs: number;
  queueMs?: number;
  fetchMs?: number;
  decodeMs?: number;
  inferenceMs?: number;
  e2eMs?: number;
  sendMs?: number;
  waitMs?: number;
  styleMs?: number;

  status: EventStatus;
  detectionsCount?: number;
  cacheHit?: boolean;
  overlayType?: string;
  backend?: string;

  error?: {
    message: string;
    type: string;
  };

  version: string;
}

export interface LogSettings {
  consoleEnabled: boolean;
}

export interface LogExport {
  exportedAt: number;
  version: string;
  userAgent: string;
  eventCount: number;
  events: WideEvent[];
}
