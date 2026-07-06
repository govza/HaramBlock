export type EventStatus = 'success' | 'error' | 'skipped' | 'cached';
export type EventContext = 'content' | 'background';
/** How far the image got through the pipeline when the terminal event fired. */
export type EventStage = 'queued' | 'sent' | 'received' | 'styled';
/** Where the applied verdict came from (content-side). */
export type PredictionSource = 'inference' | 'db-cache' | 'memory-cache';

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
  /** Machine-readable cause for skipped/error events: below-min-size, decode-rejected, load-error, send-failed, … */
  reason?: string;
  stage?: EventStage;
  source?: PredictionSource;
  detectionsCount?: number;
  batchSize?: number;
  cacheHit?: boolean;
  overlayType?: string;
  backend?: string;
  modelId?: string;

  error?: {
    message: string;
    type: string;
  };

  // Content-side anchors retained by mergeContentEvent (the merged event keeps the
  // background timestamp/totalMs; these preserve the content window for trace export).
  contentTotalMs?: number;
  contentTimestamp?: number;

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
