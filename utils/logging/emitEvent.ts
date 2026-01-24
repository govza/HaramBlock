import { pushEvent } from '@/utils/logging/eventBuffer';
import { hashUrl } from '@/utils/logging/hash';

import type { WideEvent, EventContext, EventStatus } from '@/utils/logging/types';

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
  detectionsCount?: number;
  cacheHit?: boolean;
  overlayType?: string;
  backend?: string;
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
    cacheHit: params.cacheHit,
    overlayType: params.overlayType,
    backend: params.backend,
    error: params.error ? { message: params.error.message, type: params.error.name } : undefined,
    version: getVersion(),
  };

  const logToConsole = () => {
    const prefix = `[${event.reqId}]`;
    const summary = `${event.status} ${event.hostname} +${event.totalMs}ms (${event.context})`;
    // eslint-disable-next-line no-console
    console.log(prefix, summary, event);
  };

  if (event.context === 'content') {
    // Content events: send to background, only log on failure
    void pushEvent(event).then(success => {
      if (!success) {
        logToConsole();
      }
    });
  } else {
    // Background events: don't log immediately, wait for merge with content event
    void pushEvent(event);
  }
};

// Helper to generate reqId for passing through pipeline
export const getReqId = (src: string): string => hashUrl(src);
