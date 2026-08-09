/**
 * DVR ring capture sizing (docs/VIDEO_PROCESSING.md): pick the largest capture
 * resolution — up to min(display size, the budget ladder's width ceiling) —
 * that still lets the ring span the presentation delay inside its byte budget.
 * Quality follows D: a covered range (small D) captures at the ceiling; a slow
 * session (large D) degrades toward the floor rather than shrinking the ring
 * below D, which would strand presentation on the warm-up frame forever. The
 * width ceiling comes from the global ring budget's degradation ladder
 * (ringBudget.ts); its full tier is unbounded, so there the display size is
 * the only cap — pixels the viewer cannot see are wasted bytes, everything
 * they can see is captured when the byte budget allows.
 */

/** Never capture blurrier than this — unless the ladder ceiling is already below it. */
export const DVR_CAPTURE_MIN_WIDTH = 640;
/** RGBA. */
const BYTES_PER_PIXEL = 4;
/** Ring slack past D, so a growing buffer still finds frames (matches the ring horizon slack). */
const HORIZON_SLACK_SEC = 1;

export interface CaptureScaleInput {
  nativeWidth: number;
  nativeHeight: number;
  /** Rendered width in device pixels; 0 when unknown (display cap then waived). */
  displayWidth: number;
  /** Width ceiling from the global ring budget's quality ladder. */
  maxWidth: number;
  /** Presentation delay D for the current DVR run. */
  delaySec: number;
  captureIntervalSec: number;
  maxBytes: number;
}

/** Scale factor (0, 1] applied to the native frame size before it enters the ring. */
export function dvrCaptureScale(input: CaptureScaleInput): number {
  const { nativeWidth, nativeHeight, displayWidth, maxWidth, delaySec, captureIntervalSec, maxBytes } = input;
  if (nativeWidth <= 0 || nativeHeight <= 0) return 1;

  const framesInHorizon = Math.max(1, (delaySec + HORIZON_SLACK_SEC) / captureIntervalSec);
  const bytesPerFrame = maxBytes / framesInHorizon;
  const budgetScale = Math.sqrt(bytesPerFrame / (nativeWidth * nativeHeight * BYTES_PER_PIXEL));
  const floorScale = Math.min(DVR_CAPTURE_MIN_WIDTH, maxWidth) / nativeWidth;

  const capScale = Math.min(maxWidth / nativeWidth, displayWidth > 0 ? displayWidth / nativeWidth : 1);

  return Math.min(1, capScale, Math.max(budgetScale, floorScale));
}
