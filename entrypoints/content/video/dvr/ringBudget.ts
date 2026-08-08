/**
 * Global DVR ring budget (docs/VIDEO_PROCESSING.md): one byte budget shared by
 * every active ring, tiered by the inference backend (WebGPU machines can
 * afford more than WASM ones). When the projected demand of all active
 * sessions exceeds the budget, quality degrades down a ladder — capture width
 * first, then capture rate, then ring horizon — and recovers in reverse as
 * sessions release (suspension, disposal). Demand is projected from each
 * session's registered geometry rather than measured from live ring bytes, so
 * degradation and recovery are immediate instead of trailing eviction.
 */

export type InferenceBackend = 'webgpu' | 'wasm';

export const WEBGPU_GLOBAL_BUDGET_BYTES = 512 * 1024 * 1024;
export const WASM_GLOBAL_BUDGET_BYTES = 128 * 1024 * 1024;
/** Per-session ceiling regardless of tier. */
export const SESSION_MAX_BYTES = 128 * 1024 * 1024;

/**
 * Full-quality capture cadence, ~30 fps: slightly under 1/30 so the throttle
 * cannot alias against a 60 Hz rVFC tick grid and skip extra ticks (exact
 * multiples float-compare short).
 */
export const DVR_CAPTURE_INTERVAL_SEC = 1 / 33;
/** Degraded cadence, ~15 fps (same anti-aliasing offset). */
const HALF_RATE_CAPTURE_INTERVAL_SEC = 2 / 33;

const BYTES_PER_PIXEL = 4;

export interface RingQuality {
  /** Capture width ceiling in pixels. */
  readonly maxWidth: number;
  readonly captureIntervalSec: number;
  /** Multiplier on the session's ring time horizon. */
  readonly horizonScale: number;
}

const FULL_QUALITY: RingQuality = { maxWidth: 640, captureIntervalSec: DVR_CAPTURE_INTERVAL_SEC, horizonScale: 1 };

/** Degradation order per spec: width 640 → 480 → 320, then fps 30 → 15, then horizon shrink. */
export const RING_QUALITY_LADDER: readonly RingQuality[] = [
  FULL_QUALITY,
  { maxWidth: 480, captureIntervalSec: DVR_CAPTURE_INTERVAL_SEC, horizonScale: 1 },
  { maxWidth: 320, captureIntervalSec: DVR_CAPTURE_INTERVAL_SEC, horizonScale: 1 },
  { maxWidth: 320, captureIntervalSec: HALF_RATE_CAPTURE_INTERVAL_SEC, horizonScale: 1 },
  { maxWidth: 320, captureIntervalSec: HALF_RATE_CAPTURE_INTERVAL_SEC, horizonScale: 0.5 },
  { maxWidth: 320, captureIntervalSec: HALF_RATE_CAPTURE_INTERVAL_SEC, horizonScale: 0.25 },
];

export interface SessionDemand {
  /** Native frame geometry; only the aspect ratio and any sub-ceiling width matter. */
  readonly nativeWidth: number;
  readonly nativeHeight: number;
  /** Ring time horizon this session buffers at full quality, in seconds. */
  readonly horizonSec: number;
  /**
   * Floor under horizon shrink (the session's latched D plus slack): the live
   * ring never shrinks below it, so the projection must not either.
   */
  readonly minHorizonSec: number;
}

export class DvrRingBudget {
  private backendBudget = WASM_GLOBAL_BUDGET_BYTES;
  private readonly sessions = new Map<string, SessionDemand>();
  private currentQuality: RingQuality = FULL_QUALITY;

  /** The backend is known at model load; until it arrives the WASM tier fails safe. */
  setBackend(backend: InferenceBackend): void {
    this.backendBudget = backend === 'webgpu' ? WEBGPU_GLOBAL_BUDGET_BYTES : WASM_GLOBAL_BUDGET_BYTES;
    this.reevaluate();
  }

  register(sessionId: string, demand: SessionDemand): void {
    this.sessions.set(sessionId, demand);
    this.reevaluate();
  }

  release(sessionId: string): void {
    if (this.sessions.delete(sessionId)) this.reevaluate();
  }

  /** Current quality tier, shared by every active session. */
  quality(): RingQuality {
    return this.currentQuality;
  }

  globalBudgetBytes(): number {
    return this.backendBudget;
  }

  /** Total steady-state demand of all sessions at the current quality tier. */
  projectedBytes(): number {
    return this.projectAt(this.quality());
  }

  /** Lowest ladder level whose total projected demand fits the global budget. */
  private reevaluate(): void {
    this.currentQuality =
      RING_QUALITY_LADDER.find(quality => this.projectAt(quality) <= this.backendBudget) ??
      RING_QUALITY_LADDER.at(-1) ??
      FULL_QUALITY;
  }

  private projectAt(quality: RingQuality): number {
    let total = 0;
    for (const demand of this.sessions.values()) {
      total += projectSessionBytes(demand, quality);
    }
    return total;
  }
}

function projectSessionBytes(demand: SessionDemand, quality: RingQuality): number {
  const { nativeWidth, nativeHeight, horizonSec, minHorizonSec } = demand;
  const aspect = nativeWidth > 0 && nativeHeight > 0 ? nativeHeight / nativeWidth : 9 / 16;
  const width = nativeWidth > 0 ? Math.min(quality.maxWidth, nativeWidth) : quality.maxWidth;
  const bytesPerFrame = width * width * aspect * BYTES_PER_PIXEL;
  const effectiveHorizonSec = Math.max(minHorizonSec, horizonSec * quality.horizonScale);
  const frames = effectiveHorizonSec / quality.captureIntervalSec;
  return Math.min(SESSION_MAX_BYTES, bytesPerFrame * frames);
}

/** Shared by all sessions in this content script; the backend is fed in once known. */
export const dvrRingBudget = new DvrRingBudget();
