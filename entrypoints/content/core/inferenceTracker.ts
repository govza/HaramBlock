export const IMAGE_QUEUE_WAIT_TIMEOUT_MS = 120_000;
export const IMAGE_INFERENCE_TIMEOUT_MS = 20_000;
export const MAX_IMAGE_INFERENCE_ATTEMPTS = 2;

export type ClaimResult = 'owner' | 'defer';

export type FailureOutcome = { kind: 'untracked' } | { kind: 'retry' | 'exhausted'; attempts: number };

/**
 * Bookkeeping for in-flight image inference requests, keyed by src. Each src has at most one owning
 * element (the one whose load listeners fire the request), one watchdog timer that reports a lost
 * request through `onTimeout`, and a failed-attempt count that decides between retry and exhaustion.
 * Callers never touch the three pieces separately, so they cannot drift out of sync.
 */
export interface InferenceTracker {
  claim(src: string, img: HTMLImageElement): ClaimResult;
  sent(src: string, owner: HTMLImageElement): void;
  started(src: string): void;
  settle(src: string, owner?: HTMLImageElement): boolean;
  abandon(src: string, owner: HTMLImageElement): void;
  fail(src: string): FailureOutcome;
  dispose(): void;
}

const hasPixels = (img: HTMLImageElement): boolean => img.complete && img.naturalWidth > 0;

/**
 * Defers to a live owner unless that owner is stalled without pixels while `img` already has them:
 * frameworks replace nodes before lazy images load, and a lazy copy in a hidden subtree may never
 * load, so a dead or stalled owner must not hold visible copies hostage.
 */
const shouldDeferTo = (owner: HTMLImageElement | undefined, img: HTMLImageElement): boolean => {
  if (!owner?.isConnected) return false;
  return hasPixels(owner) || !hasPixels(img);
};

export const createInferenceTracker = (onTimeout: (src: string) => void): InferenceTracker => {
  const owners = new Map<string, HTMLImageElement>();
  const watchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  const attempts = new Map<string, number>();

  const stopWatchdog = (src: string): void => {
    const timer = watchdogs.get(src);
    if (timer) clearTimeout(timer);
    watchdogs.delete(src);
  };

  const release = (src: string): void => {
    owners.delete(src);
    stopWatchdog(src);
  };

  const armWatchdog = (src: string, owner: HTMLImageElement, timeoutMs: number): void => {
    stopWatchdog(src);
    watchdogs.set(
      src,
      setTimeout(() => {
        watchdogs.delete(src);
        if (owners.get(src) === owner) onTimeout(src);
      }, timeoutMs),
    );
  };

  return {
    claim: (src, img) => {
      if (shouldDeferTo(owners.get(src), img)) return 'defer';
      owners.set(src, img);
      return 'owner';
    },

    sent: (src, owner) => armWatchdog(src, owner, IMAGE_QUEUE_WAIT_TIMEOUT_MS),

    started: src => {
      const owner = owners.get(src);
      if (owner) armWatchdog(src, owner, IMAGE_INFERENCE_TIMEOUT_MS);
    },

    settle: (src, owner) => {
      if (owner && owners.get(src) !== owner) return false;
      release(src);
      attempts.delete(src);
      return true;
    },

    abandon: (src, owner) => {
      if (owners.get(src) === owner) release(src);
    },

    fail: src => {
      if (!owners.has(src)) return { kind: 'untracked' };
      release(src);
      const attempt = (attempts.get(src) ?? 0) + 1;
      if (attempt >= MAX_IMAGE_INFERENCE_ATTEMPTS) {
        attempts.delete(src);
        return { kind: 'exhausted', attempts: attempt };
      }
      attempts.set(src, attempt);
      return { kind: 'retry', attempts: attempt };
    },

    dispose: () => {
      for (const timer of watchdogs.values()) clearTimeout(timer);
      watchdogs.clear();
      attempts.clear();
    },
  };
};
