import { pushEvent } from '@/utils/logging/eventBuffer';
import { logEventLine } from '@/utils/logging/eventFormat';
import { hashUrl } from '@/utils/logging/hash';

import type { WideEvent, EventContext, EventStatus, EventStage, PredictionSource } from '@/utils/logging/types';

const getVersion = (): string => {
  try {
    return browser.runtime.getManifest().version;
  } catch {
    return 'unknown';
  }
};

export interface EmitEventParams {
  src: string;
  hostname: string;
  context: EventContext;
  status: EventStatus;
  totalMs: number;
  // Background timing
  queueMs?: number;
  fetchMs?: number;
  decodeMs?: number;
  inferenceMs?: number;
  e2eMs?: number;
  // Content timing
  sendMs?: number;
  waitMs?: number;
  styleMs?: number;
  // Result info
  reason?: string;
  stage?: EventStage;
  source?: PredictionSource;
  detectionsCount?: number;
  batchSize?: number;
  cacheHit?: boolean;
  overlayType?: string;
  backend?: string;
  modelId?: string;
  error?: Error;
}

export const emitEvent = (params: EmitEventParams): void => {
  const event: WideEvent = {
    reqId: hashUrl(params.src),
    src: params.src,
    hostname: params.hostname,
    context: params.context,
    timestamp: Date.now(),
    status: params.status,
    reason: params.reason,
    stage: params.stage,
    source: params.source,
    totalMs: params.totalMs,
    queueMs: params.queueMs,
    fetchMs: params.fetchMs,
    decodeMs: params.decodeMs,
    inferenceMs: params.inferenceMs,
    e2eMs: params.e2eMs,
    sendMs: params.sendMs,
    waitMs: params.waitMs,
    styleMs: params.styleMs,
    detectionsCount: params.detectionsCount,
    batchSize: params.batchSize,
    cacheHit: params.cacheHit,
    overlayType: params.overlayType,
    backend: params.backend,
    modelId: params.modelId,
    error: params.error ? { message: params.error.message, type: params.error.name } : undefined,
    version: getVersion(),
  };

  if (event.context === 'content') {
    // Content events: send to background, only log on failure
    void pushEvent(event).then(success => {
      if (!success) {
        logEventLine(event, event.context);
      }
    });
  } else {
    // Background events: don't log immediately, wait for merge with content event
    void pushEvent(event);
  }
};

// Helper to generate reqId for passing through pipeline
export const getReqId = (src: string): string => hashUrl(src);
