import { emitEvent } from '@/utils/logging/emitEvent';

export interface ContentTimingContext {
  src: string;
  hostname: string;
  startTime: number;
  sendTime?: number;
  receiveTime?: number;
}

// Store active timing contexts by src
const activeTimings = new Map<string, ContentTimingContext>();

export const startContentTiming = (src: string, hostname: string): void => {
  // The reconciliation pass re-enters the processing path while a verdict is
  // pending; restarting would destroy the baseline and the sent/received marks.
  if (activeTimings.has(src)) return;
  activeTimings.set(src, {
    src,
    hostname,
    startTime: performance.now(),
  });
};

export const markSent = (src: string): void => {
  const ctx = activeTimings.get(src);
  if (ctx) {
    ctx.sendTime = performance.now();
  }
};

export const markReceived = (src: string): void => {
  const ctx = activeTimings.get(src);
  if (ctx) {
    ctx.receiveTime = performance.now();
  }
};

export const completeContentTiming = (
  src: string,
  result: {
    status: 'success' | 'error' | 'skipped';
    detectionsCount?: number;
    overlayType?: string;
    error?: Error;
  },
): void => {
  const ctx = activeTimings.get(src);
  if (!ctx) return;

  const now = performance.now();
  const totalMs = Math.round(now - ctx.startTime);
  const sendMs = ctx.sendTime ? Math.round(ctx.sendTime - ctx.startTime) : undefined;
  const waitMs = ctx.sendTime && ctx.receiveTime ? Math.round(ctx.receiveTime - ctx.sendTime) : undefined;
  const styleMs = ctx.receiveTime ? Math.round(now - ctx.receiveTime) : undefined;

  emitEvent({
    src: ctx.src,
    hostname: ctx.hostname,
    context: 'content',
    status: result.status,
    totalMs,
    sendMs,
    waitMs,
    styleMs,
    detectionsCount: result.detectionsCount,
    overlayType: result.overlayType,
    error: result.error,
  });

  activeTimings.delete(src);
};

export const cancelContentTiming = (src: string): void => {
  activeTimings.delete(src);
};
