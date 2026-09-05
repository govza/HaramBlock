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

import { ATTR, getLogger } from '@/utils/telemetry';

const log = getLogger('dvrRingBudget');

export type InferenceBackend = 'webgpu' | 'wasm';

export const WEBGPU_GLOBAL_BUDGET_BYTES = 1024 * 1024 * 1024;
export const WASM_GLOBAL_BUDGET_BYTES = 128 * 1024 * 1024;
/**
 * Per-session ceiling, backend-tiered like the global budget: a 1080p30 ring
 * over the full horizon needs ~600 MB, which only WebGPU-class hardware can
 * afford. The WASM tier keeps the historical cap and degrades instead.
 */
export const WEBGPU_SESSION_MAX_BYTES = 768 * 1024 * 1024;
export const WASM_SESSION_MAX_BYTES = 128 * 1024 * 1024;

/**
 * Full-quality capture cadence, ~30 fps: slightly under 1/30 so the throttle
 * cannot alias against a 60 Hz rVFC tick grid and skip extra ticks (exact
 * multiples float-compare short).
 */
export const DVR_CAPTURE_INTERVAL_SEC = 1 / 33;
/** Degraded cadence, ~15 fps (same anti-aliasing offset). */
const HALF_RATE_CAPTURE_INTERVAL_SEC = 2 / 33;
export const NATIVE_RATE_CAPTURE_INTERVAL_SEC = 0;

const BYTES_PER_PIXEL = 4;

export interface RingQuality {
  /** Capture width ceiling in pixels. */
  readonly maxWidth: number;
  /** Raw-ring capture cadence: RGBA bytes scale with fps, so the raw ring stays fps-capped. */
  readonly captureIntervalSec: number;
  readonly encodedCaptureIntervalSec: number;
  /** Multiplier on the session's ring time horizon. */
  readonly horizonScale: number;
}

/**
 * The full tier has no ladder ceiling: capture is capped by what the viewer
 * actually sees (the session's registered display width, up to native), so an
 * embedded player buffers cheaply while a fullscreen 1080p one captures at
 * full resolution when the byte budget allows.
 */
const FULL_QUALITY: RingQuality = {
  maxWidth: Number.POSITIVE_INFINITY,
  captureIntervalSec: DVR_CAPTURE_INTERVAL_SEC,
  encodedCaptureIntervalSec: NATIVE_RATE_CAPTURE_INTERVAL_SEC,
  horizonScale: 1,
};

const RATE_FLOOR_QUALITY: RingQuality = {
  maxWidth: 320,
  captureIntervalSec: HALF_RATE_CAPTURE_INTERVAL_SEC,
  encodedCaptureIntervalSec: DVR_CAPTURE_INTERVAL_SEC,
  horizonScale: 1,
};

export const RING_QUALITY_LADDER: readonly RingQuality[] = [
  FULL_QUALITY,
  { ...FULL_QUALITY, maxWidth: 1280 },
  { ...FULL_QUALITY, maxWidth: 640 },
  { ...FULL_QUALITY, maxWidth: 480 },
  { ...FULL_QUALITY, maxWidth: 320 },
  RATE_FLOOR_QUALITY,
  { ...RATE_FLOOR_QUALITY, horizonScale: 0.5 },
  { ...RATE_FLOOR_QUALITY, horizonScale: 0.25 },
];

export interface SessionDemand {
  /** Native frame geometry; only the aspect ratio and any sub-ceiling width matter. */
  readonly nativeWidth: number;
  readonly nativeHeight: number;
  /**
   * Finite capture-width cap for this session: rendered width in device
   * pixels, up to native. The full ladder tier has no ceiling of its own, so
   * this is what keeps its projection bounded.
   */
  readonly captureMaxWidth: number;
  /** Ring time horizon this session buffers at full quality, in seconds. */
  readonly horizonSec: number;
  /**
   * Floor under horizon shrink (the session's latched D plus slack): the live
   * ring never shrinks below it, so the projection must not either.
   */
  readonly minHorizonSec: number;
  /**
   * Set for sessions on the WebCodecs-encoded store: demand is bitrate ×
   * horizon (plus a small decode-lookahead allowance) instead of the RGBA
   * projection, so encoded sessions barely register on the ladder and never
   * degrade raw sessions on their behalf.
   */
  readonly encodedBytesPerSec?: number;
}

/** Decode-lookahead allowance for encoded sessions: a handful of RGBA frames (sized for 60 fps lookahead). */
const ENCODED_DECODE_LOOKAHEAD_FRAMES = 10;

export class DvrRingBudget {
  private backendBudget = WASM_GLOBAL_BUDGET_BYTES;
  private backendSessionMax = WASM_SESSION_MAX_BYTES;
  private readonly sessions = new Map<string, SessionDemand>();
  private currentQuality: RingQuality = FULL_QUALITY;

  /** The backend is known at model load; until it arrives the WASM tier fails safe. */
  setBackend(backend: InferenceBackend): void {
    this.backendBudget = backend === 'webgpu' ? WEBGPU_GLOBAL_BUDGET_BYTES : WASM_GLOBAL_BUDGET_BYTES;
    this.backendSessionMax = backend === 'webgpu' ? WEBGPU_SESSION_MAX_BYTES : WASM_SESSION_MAX_BYTES;
    this.reevaluate();
  }

  /** Per-session byte ceiling at the current backend tier (ring limit and capture sizing). */
  sessionMaxBytes(): number {
    return this.backendSessionMax;
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
    const previous = this.currentQuality;
    this.currentQuality =
      RING_QUALITY_LADDER.find(quality => this.projectAt(quality) <= this.backendBudget) ??
      RING_QUALITY_LADDER.at(-1) ??
      FULL_QUALITY;
    if (this.currentQuality === previous) return;
    const degraded = RING_QUALITY_LADDER.indexOf(this.currentQuality) > RING_QUALITY_LADDER.indexOf(previous);
    log.info(degraded ? 'video.dvr.budget_degraded' : 'video.dvr.budget_recovered', {
      [ATTR.budgetMaxWidth]: this.currentQuality.maxWidth,
      [ATTR.budgetCaptureIntervalSec]: this.currentQuality.captureIntervalSec,
      [ATTR.budgetHorizonScale]: this.currentQuality.horizonScale,
      [ATTR.budgetProjectedBytes]: this.projectedBytes(),
      [ATTR.budgetGlobalBytes]: this.backendBudget,
      sessions: this.sessions.size,
    });
  }

  private projectAt(quality: RingQuality): number {
    let total = 0;
    for (const demand of this.sessions.values()) {
      total += projectSessionBytes(demand, quality, this.backendSessionMax);
    }
    return total;
  }
}

function projectSessionBytes(demand: SessionDemand, quality: RingQuality, sessionMaxBytes: number): number {
  const { nativeWidth, nativeHeight, captureMaxWidth, horizonSec, minHorizonSec, encodedBytesPerSec } = demand;
  if (encodedBytesPerSec !== undefined) {
    const effectiveHorizonSec = Math.max(minHorizonSec, horizonSec * quality.horizonScale);
    // The encoded ring captures and decodes at native resolution.
    const lookaheadBytes = nativeWidth * nativeHeight * BYTES_PER_PIXEL * ENCODED_DECODE_LOOKAHEAD_FRAMES;
    return Math.min(sessionMaxBytes, encodedBytesPerSec * effectiveHorizonSec + lookaheadBytes);
  }
  const aspect = nativeWidth > 0 && nativeHeight > 0 ? nativeHeight / nativeWidth : 9 / 16;
  const widthCeiling = Math.min(quality.maxWidth, captureMaxWidth);
  const width = nativeWidth > 0 ? Math.min(widthCeiling, nativeWidth) : widthCeiling;
  const bytesPerFrame = width * width * aspect * BYTES_PER_PIXEL;
  const effectiveHorizonSec = Math.max(minHorizonSec, horizonSec * quality.horizonScale);
  const frames = effectiveHorizonSec / quality.captureIntervalSec;
  return Math.min(sessionMaxBytes, bytesPerFrame * frames);
}

/** Shared by all sessions in this content script; the backend is fed in once known. */
export const dvrRingBudget = new DvrRingBudget();
