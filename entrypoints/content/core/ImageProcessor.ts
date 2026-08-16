import {
  requestGifFrameInference,
  requestImageInference,
  requestToggleUpdate,
} from '@/entrypoints/content/communication/sender';
import { PredictionCache } from '@/entrypoints/content/core/predictionCache';
import {
  decodeGifFrames,
  gifInferenceFrameCap,
  sampleFrameIndices,
  type DecodedGifFrame,
} from '@/entrypoints/content/gif/gifDecoder';
import { isGifCandidate } from '@/entrypoints/content/gif/gifSupport';
import { BLACKLIST_ATTR, BLUR_CLASS } from '@/entrypoints/content/presentation/constants';
import { gifMaskPlayer } from '@/entrypoints/content/presentation/gifMaskPlayer';
import { imageMaskOverlay } from '@/entrypoints/content/presentation/imageMaskOverlay';
import {
  applyBlacklistStyling,
  applyInitialImageStyling,
  finalizeImageProcessing,
  hasBlacklistStyling,
  hasInitialStyling,
  resetImageStyling,
} from '@/entrypoints/content/presentation/initialStyling';
import { applyPredictionsStyling } from '@/entrypoints/content/presentation/predictionStyling';
import {
  destroyQuickToggle,
  initQuickToggle,
  predictionToggleRegistration,
  registerQuickToggle,
  unregisterQuickToggle,
} from '@/entrypoints/content/presentation/quickToggle';
import { setSrcDriftHandler } from '@/entrypoints/content/presentation/srcDrift';
import { IS_CHROME } from '@/utils/constants/environment';
import { GIF_MIN_MASK_INERTIA } from '@/utils/constants/gif';
import { INFERENCE_PRIORITY } from '@/utils/constants/inference';
import { logger } from '@/utils/logger';
import {
  cancelContentTiming,
  completeContentTiming,
  markReceived,
  markSent,
  startContentTiming,
} from '@/utils/logging';
import { waitForMessageChannel } from '@/utils/messaging/content';
import {
  shouldBlock,
  type GifFrameInferenceResult,
  type IGifFramePrediction,
  type IHostSettings,
  type IImagePrediction,
  type ImageInferenceResult,
} from '@/utils/types';

import type { BadgeCounter } from '@/entrypoints/content/core/BadgeCounter';

// =============================================================================
// Constants
// =============================================================================

const SVG_PATTERN = /\.svg(?:[?#]|$)|image\/svg\+xml/i;
const MAX_CACHE_SIZE = 500;
const SRC_STABILIZATION_DELAY = 150;
const IMAGE_INFERENCE_TIMEOUT_MS = 20_000;
const MAX_IMAGE_INFERENCE_ATTEMPTS = 2;

// Animated GIFs: cap tracked decode sessions and fail closed if frame verdicts
// never arrive. Native <img> does not expose current-frame masking, so finalized
// unsafe GIFs are replayed through a canvas player.
const MAX_GIF_SESSIONS = 500;
const GIF_VERDICT_TIMEOUT_MS = 20000;

/**
 * Aggregation state for one animated GIF (keyed by src). Every frame is decoded for
 * playback, but inference runs on a sampled subset; the verdict finalizes once that
 * subset has returned (or the fail-closed timeout fires).
 */
interface GifSession {
  sessionId: string;
  frameCount: number; // Expected inference verdicts = sampled frame count (0 until decode completes)
  received: number; // Frame verdicts received so far
  failedFrames: number;
  frames?: DecodedGifFrame[]; // All decoded frames; released once a GIF is judged safe
  framePredictions: Map<number, IGifFramePrediction>; // Keyed by decoded frame index (sampled only)
  maskInertia: number; // Frames a detection persists for playback; tracks the sampling stride
  aggregatePrediction?: IImagePrediction;
  finalized: boolean;
  disposed: boolean;
  timeoutId?: ReturnType<typeof setTimeout>;
}

// =============================================================================
// ImageProcessor
// =============================================================================

/**
 * Processes images with minimal blocking and DOM-derived state.
 *
 * State is derived from DOM, not tracked separately:
 * - No blur class, no overlay → Unprocessed
 * - Has blur class, no overlay → Pending inference
 * - Has overlay → Complete
 *
 * Key design:
 * - Idempotent operations (safe to call multiple times)
 * - Fire and forget async work
 * - Predictions matched by src (stale ones find no matches)
 * - Self-cleaning overlays (via src tracking in overlay modules)
 */
export class ImageProcessor {
  private readonly cache = new PredictionCache(MAX_CACHE_SIZE);
  private readonly gifSessions = new Map<string, GifSession>();
  // src → the element whose load listeners drive the request (see queueInference)
  private readonly pendingInference = new Map<string, HTMLImageElement>();
  private readonly pendingInferenceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inferenceAttempts = new Map<string, number>();
  /** Last resolved source seen for an element; filters Reddit's no-op attribute churn. */
  private readonly resolvedSrcByImage = new WeakMap<HTMLImageElement, string>();
  private readonly srcChangeDebounce = new WeakMap<HTMLImageElement, ReturnType<typeof setTimeout>>();
  /** Unloaded copies that deferred to a pending owner and await their own load (see queueInference). */
  private readonly deferredUntilLoad = new WeakSet<HTMLImageElement>();
  private readonly visibilityMap = new WeakMap<HTMLImageElement, boolean>();
  private readonly visibilityObserver: IntersectionObserver;

  // Track shadow roots that contain processed images (for efficient querying)
  private readonly knownShadowRoots = new Set<ShadowRoot>();

  constructor(
    private readonly hostSettings: IHostSettings,
    private readonly badgeCounter: BadgeCounter,
  ) {
    initQuickToggle((src, forcedVisibility) => this.handleToggle(src, forcedVisibility));

    // Fail-closed route for srcset re-selection (lightbox resize): the overlay
    // self-clean is the only place that detects it — no attribute mutates, so
    // DomObserver stays silent. handleSrcChange re-blurs and reprocesses.
    setSrcDriftHandler(img => this.handleSrcChange(img));

    this.visibilityObserver = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          this.visibilityMap.set(entry.target as HTMLImageElement, entry.isIntersecting);
        }
      },
      { rootMargin: '200px' },
    );
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Process an image. Idempotent - safe to call multiple times.
   * This is the main entry point for both new images and attribute changes.
   */
  process(img: HTMLImageElement): void {
    const src = img.currentSrc || img.src;
    if (!src) return;
    this.resolvedSrcByImage.set(img, src);

    this.visibilityObserver.observe(img);
    this.trackShadowRoot(img);

    // Skip non-processable formats
    if (SVG_PATTERN.test(src)) {
      finalizeImageProcessing(img, 'skipped');
      return;
    }

    // Blacklist policy: apply blacklist styling if not already applied
    if (this.hostSettings.policy.behavior === 'blacklist') {
      if (hasBlacklistStyling(img)) {
        return; // Already blacklisted
      }
      // Clear any overlays from previous state and apply blacklist styling
      this.clearOverlays(img);
      applyBlacklistStyling(img, this.hostSettings);
      this.badgeCounter.trackDetections(img, src, 1);
      return;
    }

    // GIFs and static images are independent targets; each <img> belongs to one.
    const { targets } = this.hostSettings.policy;
    if (isGifCandidate(src, img.dataset.contentType)) {
      if (!targets.gif) return;
      this.processGif(img, src);
      return;
    }
    if (!targets.image) return;

    // Skip if already has overlay for current src, but re-stamp the processed
    // attribute (mobile srcset changes can clear it while the overlay persists).
    if (this.hasOverlayForSrc(img, src)) {
      const cached = this.cache.get(src);
      if (cached) {
        finalizeImageProcessing(img, cached.predictions.length > 0 ? 'unsafe' : 'safe');
      }
      return;
    }

    // Check cache first - apply immediately if available
    const cached = this.cache.get(src);
    if (cached) {
      this.applyPrediction(img, cached);
      return;
    }

    // Start timing for this image (new processing path)
    startContentTiming(src, this.hostSettings.hostname);

    // Apply blur if not already present (idempotent)
    if (!hasInitialStyling(img)) {
      applyInitialImageStyling(img, this.hostSettings);
    }

    // Queue for inference (deduped by src)
    this.queueInference(img, src);
  }

  /**
   * Process multiple images.
   */
  processAll(images: HTMLImageElement[]): void {
    for (const img of images) {
      this.process(img);
    }
  }

  /**
   * Handle src attribute change - debounce to let src stabilize before reprocessing.
   * Google Images rapidly changes src (quality upgrades), so we wait for it to settle.
   */
  handleSrcChange(img: HTMLImageElement): void {
    const resolvedSrc = img.currentSrc || img.src;
    const previousSrc = this.resolvedSrcByImage.get(img);
    if (resolvedSrc === previousSrc) {
      // Lit/React frequently re-stamp an unchanged src/srcset. Treating that
      // as a source replacement clears a valid verdict and can reset the
      // debounce forever under continuous Reddit feed churn.
      return;
    }
    if (resolvedSrc) this.resolvedSrcByImage.set(img, resolvedSrc);
    else this.resolvedSrcByImage.delete(img);

    // Clear any existing overlays (they may be for old src)
    this.clearOverlays(img);

    // Ensure blur is applied while waiting for stabilization
    if (!hasInitialStyling(img)) {
      applyInitialImageStyling(img, this.hostSettings);
    }

    // Cancel any pending debounce for this image
    const existingTimeout = this.srcChangeDebounce.get(img);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Debounce: wait for src to stabilize before processing
    const timeout = setTimeout(() => {
      this.srcChangeDebounce.delete(img);
      const src = img.currentSrc || img.src;
      if (src) {
        this.process(img);
      }
    }, SRC_STABILIZATION_DELAY);

    this.srcChangeDebounce.set(img, timeout);
  }

  /**
   * Seed cache with predictions (e.g., from background on init).
   */
  seedCache(predictions: IImagePrediction[]): void {
    for (const pred of predictions) {
      this.cache.set(pred.src, pred);
    }
  }

  /**
   * Handle inference results from background. Successful predictions are cached
   * and applied to matching images; errored results feed the retry counter
   * (transient failures deserve the retry) and fail open once exhausted.
   */
  handleInferenceResults(results: ImageInferenceResult[]): void {
    for (const result of results) {
      if (result.status === 'error') {
        this.handleInferenceFailure(result.src, result.reason);
        continue;
      }
      const pred = result.prediction;
      this.cache.set(pred.src, pred);
      this.clearPendingInference(pred.src, undefined, true);

      // Find and update all matching images
      const images = this.findImagesBySrc(pred.src);
      for (const img of images) {
        this.applyPrediction(img, pred);
      }
    }
  }

  /**
   * Clean up when image removed from DOM.
   */
  handleRemoved(img: HTMLImageElement): void {
    const src = img.currentSrc || img.src;
    if (src) {
      cancelContentTiming(src);
    }
    const timeout = this.srcChangeDebounce.get(img);
    if (timeout) {
      clearTimeout(timeout);
      this.srcChangeDebounce.delete(img);
    }
    this.visibilityObserver.unobserve(img);
    gifMaskPlayer.clearPlayer(img);
    unregisterQuickToggle(img);
  }

  /**
   * Clean up resources when processor is disposed.
   */
  dispose(): void {
    setSrcDriftHandler(null);
    this.visibilityObserver.disconnect();
    for (const timer of this.pendingInferenceTimers.values()) clearTimeout(timer);
    this.pendingInferenceTimers.clear();
    this.inferenceAttempts.clear();
    for (const session of this.gifSessions.values()) {
      session.disposed = true;
      if (session.timeoutId) clearTimeout(session.timeoutId);
      this.releaseGifFrames(session.frames);
    }
    this.gifSessions.clear();
    destroyQuickToggle();
  }

  toggleImage(src: string, forcedVisibility: IImagePrediction['forcedVisibility']): void {
    this.handleToggle(src, forcedVisibility);
  }

  private handleToggle(src: string, forcedVisibility: IImagePrediction['forcedVisibility']): void {
    const cached = this.cache.get(src);
    if (!cached) return;

    const updated = { ...cached, forcedVisibility };
    this.cache.set(src, updated);
    void requestToggleUpdate(src, forcedVisibility);

    const gifSession = this.gifSessions.get(src);
    if (gifSession?.finalized && gifSession.aggregatePrediction) {
      gifSession.aggregatePrediction = updated;
      const images = this.findAllImagesBySrc(src);
      for (const img of images) {
        this.applyGifVerdict(img, src, updated);
      }
      return;
    }

    let detectionCount = updated.predictions.length;
    if (forcedVisibility === 'visible') detectionCount = 0;
    else if (forcedVisibility === 'blocked') detectionCount = 1;

    const images = this.findAllImagesBySrc(src);
    for (const img of images) {
      this.clearOverlays(img);
      if (forcedVisibility === 'blocked') {
        applyBlacklistStyling(img, this.hostSettings);
      } else if (forcedVisibility === 'auto' && updated.predictions.length > 0) {
        void applyPredictionsStyling([img], [updated], this.hostSettings);
      }
      // Always register quick toggle for all states
      this.registerToggle(img, updated);
      this.badgeCounter.trackDetections(img, src, detectionCount);
    }
  }

  // ===========================================================================
  // State Queries (DOM-derived)
  // ===========================================================================

  private hasOverlayForSrc(img: HTMLImageElement, _src: string): boolean {
    // Check if any overlay exists - they self-clean if src doesn't match
    return Boolean(imageMaskOverlay.hasMaskOverlay(img) || gifMaskPlayer.hasPlayer(img));
  }

  // ===========================================================================
  // Inference Queue
  // ===========================================================================

  private queueInference(img: HTMLImageElement, src: string): void {
    // Dedupe by src - only one request per unique src. But the pending entry
    // is only alive as long as the element carrying its load listeners is:
    // frameworks (Reddit's lightbox) replace nodes before lazy images load,
    // and a dedupe against a dead owner would leave the src pending forever —
    // every later copy of it dropped here, stuck behind the initial blur.
    const owner = this.pendingInference.get(src);
    if (owner && owner.isConnected) {
      const ownerReady = owner.complete && owner.naturalWidth > 0;
      const imgReady = img.complete && img.naturalWidth > 0;
      // Defer to the owner unless it is stalled (not loaded — e.g. a lazy
      // copy in a hidden subtree that may never start loading) while this
      // copy already has pixels; then take over so visible copies aren't
      // held hostage. A later duplicate send from the old owner is harmless.
      if (ownerReady || !imgReady) {
        // An unloaded deferrer may resolve a different currentSrc than the
        // verdict's src (lazy load + srcset picks a larger candidate), so the
        // broadcast can miss it and nothing else revisits it — a lazy load
        // fires no attribute mutation. Re-enter process() once it has pixels;
        // by then the verdict for its resolved src is usually already cached.
        if (!imgReady && !this.deferredUntilLoad.has(img)) {
          this.deferredUntilLoad.add(img);
          img.addEventListener(
            'load',
            () => {
              this.deferredUntilLoad.delete(img);
              this.process(img);
            },
            { once: true },
          );
        }
        return;
      }
    }

    // Mark pending immediately (with this element as owner) to prevent
    // duplicate load handlers
    this.pendingInference.set(src, img);

    const sendRequest = async () => {
      // If src changed before load (common with srcset), reprocess with new src
      const currentSrc = img.currentSrc || img.src;
      if (currentSrc !== src) {
        this.clearPendingInference(src, img);
        // Re-process with the actual loaded URL instead of just aborting
        this.process(img);
        cancelContentTiming(src);
        return;
      }

      // Skip only if all currently pending elements for this src are below threshold.
      if (this.isBelowMinSizeForSrc(src, img)) {
        this.clearPendingInference(src, img, true);
        completeContentTiming(src, { status: 'skipped' });
        this.finalizeAllImagesForSrc(src, 'skipped');
        return;
      }

      try {
        markSent(src);
        this.armInferenceWatchdog(src, img);
        const isVisible = this.visibilityMap.get(img) ?? false;
        const priority = isVisible ? INFERENCE_PRIORITY.visibleImage : INFERENCE_PRIORITY.offscreenImage;
        await requestImageInference(this.hostSettings.hostname, img, priority);
      } catch (err) {
        if (this.pendingInference.get(src) !== img) return;
        this.clearPendingInference(src, img, true);
        completeContentTiming(src, { status: 'error', error: err instanceof Error ? err : undefined });
        this.finalizeAllImagesForSrc(src, 'skipped');
      }
    };

    const handleError = (reason?: unknown) => {
      if (this.pendingInference.get(src) !== img) return;
      this.clearPendingInference(src, img, true);
      let error: Error;
      if (reason instanceof Error) {
        error = reason;
      } else if (reason !== undefined) {
        error = new Error(typeof reason === 'string' ? reason : JSON.stringify(reason));
      } else {
        error = new Error('Image failed to load');
      }
      completeContentTiming(src, { status: 'error', error });
      this.finalizeAllImagesForSrc(src, 'skipped');
    };

    if (img.complete && img.naturalWidth > 0) {
      // Image already loaded with dimensions - send immediately
      void sendRequest();
    } else {
      // Use both decode() and load event - whichever fires first wins
      // This handles edge cases where one mechanism fails
      let handled = false;
      const onReady = () => {
        if (handled) return;
        handled = true;
        void sendRequest();
      };
      const onFail = (reason?: unknown) => {
        if (handled) return;
        handled = true;
        handleError(reason);
      };

      // decode() rejection is only fatal when the browser has given up on the
      // image (complete with no dimensions). Firefox rejects decode() for
      // loading="lazy" images that haven't started loading and for src swaps
      // mid-decode — treating those as errors revealed images unmasked and the
      // later load event was ignored. Keep the blur and let load/error decide.
      img.decode().then(onReady, (reason: unknown) => {
        if (img.complete && img.naturalWidth === 0) {
          onFail(reason ?? new Error(`Decode failed: ${img.src.substring(0, 80)}`));
        }
      });
      img.addEventListener('load', onReady, { once: true });
      img.addEventListener('error', () => onFail(new Error(`Load error: ${img.src.substring(0, 80)}`)), {
        once: true,
      });
    }
  }

  private armInferenceWatchdog(src: string, owner: HTMLImageElement): void {
    const existing = this.pendingInferenceTimers.get(src);
    if (existing) clearTimeout(existing);
    this.pendingInferenceTimers.set(
      src,
      setTimeout(() => {
        this.pendingInferenceTimers.delete(src);
        if (this.pendingInference.get(src) !== owner) return;
        this.handleInferenceFailure(src);
      }, IMAGE_INFERENCE_TIMEOUT_MS),
    );
  }

  /**
   * A pending inference failed (errored result from background, or the
   * watchdog fired with no reply). Retry with the best candidate element,
   * failing open once attempts are exhausted.
   */
  private handleInferenceFailure(src: string, reason?: string): void {
    if (!this.pendingInference.has(src)) return;
    this.clearPendingInference(src);

    const attempts = (this.inferenceAttempts.get(src) ?? 0) + 1;
    this.inferenceAttempts.set(src, attempts);

    if (attempts >= MAX_IMAGE_INFERENCE_ATTEMPTS) {
      this.inferenceAttempts.delete(src);
      completeContentTiming(src, {
        status: 'error',
        error: new Error(`Image inference failed after ${attempts} attempts${reason ? `: ${reason}` : ''}`),
      });
      this.finalizeAllImagesForSrc(src, 'skipped');
      return;
    }

    const candidates = this.findImagesBySrc(src);
    const retryOwner =
      candidates.find(candidate => this.visibilityMap.get(candidate) && candidate.complete) ??
      candidates.find(candidate => candidate.complete) ??
      candidates[0];
    if (retryOwner) this.process(retryOwner);
    else this.inferenceAttempts.delete(src);
  }

  private clearPendingInference(src: string, owner?: HTMLImageElement, resetAttempts = false): void {
    if (owner && this.pendingInference.get(src) !== owner) return;
    this.pendingInference.delete(src);
    const timer = this.pendingInferenceTimers.get(src);
    if (timer) clearTimeout(timer);
    this.pendingInferenceTimers.delete(src);
    if (resetAttempts) this.inferenceAttempts.delete(src);
  }

  private isBelowMinSize(img: HTMLImageElement): boolean {
    const w = img.clientWidth || img.naturalWidth;
    const h = img.clientHeight || img.naturalHeight;
    return w < this.hostSettings.minSize.width || h < this.hostSettings.minSize.height;
  }

  private isBelowMinSizeForSrc(src: string, seedImg: HTMLImageElement): boolean {
    const candidates = this.findImagesBySrc(src);
    if (!candidates.includes(seedImg)) {
      candidates.push(seedImg);
    }
    return candidates.every(candidate => this.isBelowMinSize(candidate));
  }

  /**
   * Finalize all images with the given src. Used when one image is skipped/errors
   * to ensure other deduplicated images with the same src are also finalized.
   */
  private finalizeAllImagesForSrc(src: string, status: 'safe' | 'unsafe' | 'skipped'): void {
    const images = this.findImagesBySrc(src);
    for (const img of images) {
      finalizeImageProcessing(img, status);
    }
  }

  // ===========================================================================
  // Animated GIF Processing
  // ===========================================================================

  /**
   * Inspect a sampled subset of an animated GIF's frames. Idempotent per src:
   * re-running for the same GIF re-applies the known verdict instead of re-decoding.
   */
  private processGif(img: HTMLImageElement, src: string): void {
    const existing = this.gifSessions.get(src);
    if (existing) {
      if (existing.finalized && existing.aggregatePrediction) {
        this.applyGifVerdict(img, src, existing.aggregatePrediction);
      } else if (!hasInitialStyling(img)) {
        // Another element shares this GIF and is still being inspected. Blur this one
        // too so it stays hidden and is found when the verdict lands.
        applyInitialImageStyling(img, this.hostSettings);
      }
      return;
    }

    const session: GifSession = {
      sessionId: crypto.randomUUID(),
      frameCount: 0,
      received: 0,
      failedFrames: 0,
      framePredictions: new Map(),
      maskInertia: GIF_MIN_MASK_INERTIA,
      finalized: false,
      disposed: false,
    };
    this.gifSessions.set(src, session);
    this.evictGifSessionsIfNeeded();

    startContentTiming(src, this.hostSettings.hostname);
    if (!hasInitialStyling(img)) {
      applyInitialImageStyling(img, this.hostSettings);
    }

    void this.decodeAndSendGif(img, src, session);
  }

  private async decodeAndSendGif(img: HTMLImageElement, src: string, session: GifSession): Promise<void> {
    // GIF frames are transferred like video frames (no URL fallback). On Chrome that
    // needs the MessageChannel; if it is unavailable, fall back to single-frame.
    if (IS_CHROME && !(await waitForMessageChannel())) {
      this.fallbackToSingleFrame(img, src, session);
      return;
    }

    if (this.isBelowMinSizeForSrc(src, img)) {
      this.gifSessions.delete(src);
      completeContentTiming(src, { status: 'skipped' });
      this.finalizeAllImagesForSrc(src, 'skipped');
      return;
    }

    let decoded: Awaited<ReturnType<typeof decodeGifFrames>> = null;
    try {
      const response = await fetch(src, { cache: 'force-cache' });
      if (!response.ok) {
        throw new Error(`Failed to fetch GIF (${response.status})`);
      }
      const blob = await response.blob();
      decoded = await decodeGifFrames(blob);
    } catch (error) {
      logger.withTag('ImageProcessor').debug('GIF fetch/decode failed, falling back to single frame:', error);
    }

    if (session.disposed) {
      this.releaseGifFrames(decoded?.frames);
      return;
    }

    // Not an animated GIF (single frame / undecodable) -> normal single-frame path.
    if (!decoded) {
      this.fallbackToSingleFrame(img, src, session);
      return;
    }

    // Decode every frame for playback, but only inspect an evenly-spread subset so long
    // GIFs don't flood the inference queue. Masks persist across the gap between sampled
    // frames (see maskInertia) so coverage stays fail-safe.
    session.frames = decoded.frames;
    const totalFrames = decoded.frames.length;
    const inferenceIndices = sampleFrameIndices(totalFrames, gifInferenceFrameCap(totalFrames));
    session.frameCount = inferenceIndices.length;
    session.maskInertia = Math.max(GIF_MIN_MASK_INERTIA, Math.ceil(totalFrames / Math.max(1, inferenceIndices.length)));
    markSent(src);

    const isVisible = this.visibilityMap.get(img) ?? false;
    const priority = isVisible ? INFERENCE_PRIORITY.visibleImage : INFERENCE_PRIORITY.offscreenImage;

    // Safety net: if verdicts never arrive, fail closed instead of revealing the GIF.
    session.timeoutId = setTimeout(() => this.finalizeGif(src, true), GIF_VERDICT_TIMEOUT_MS);

    await Promise.all(
      inferenceIndices.map(async index => {
        const frame = decoded.frames[index];
        if (!frame) return;
        try {
          const inferenceBitmap = await createImageBitmap(frame.bitmap);
          await requestGifFrameInference({
            src,
            bitmap: inferenceBitmap,
            hostname: this.hostSettings.hostname,
            sessionId: session.sessionId,
            frameIndex: frame.frameIndex,
            frameCount: session.frameCount,
            originalWidth: decoded.width,
            originalHeight: decoded.height,
            priority,
          });
        } catch (error) {
          logger.withTag('ImageProcessor').debug('GIF frame send failed:', error);
          this.handleGifFrameError(src, session);
        }
      }),
    );
  }

  /**
   * Aggregate per-frame inference results. Errored frames count as failed so the
   * session can finalize (fail closed) without waiting out the verdict timeout.
   * Finalization waits until every sampled frame has returned (or failed); the
   * fail-closed timeout covers verdicts that never arrive.
   */
  handleGifFrameResults(results: GifFrameInferenceResult[]): void {
    for (const result of results) {
      if (result.status === 'error') {
        const session = this.gifSessions.get(result.src);
        if (!session || session.sessionId !== result.sessionId) continue;
        this.handleGifFrameError(result.src, session);
        continue;
      }
      const pred = result.prediction;
      const session = this.gifSessions.get(pred.src);
      if (!session || session.sessionId !== pred.sessionId || session.finalized) {
        continue;
      }

      if (!session.framePredictions.has(pred.frameIndex)) {
        session.received += 1;
      }
      session.framePredictions.set(pred.frameIndex, pred);

      if (session.frameCount > 0 && session.received + session.failedFrames >= session.frameCount) {
        this.finalizeGif(pred.src, session.failedFrames > 0);
      }
    }
  }

  private handleGifFrameError(src: string, session: GifSession): void {
    if (session.finalized || session.disposed) return;
    session.failedFrames += 1;
    if (session.frameCount > 0 && session.received + session.failedFrames >= session.frameCount) {
      this.finalizeGif(src, true);
    }
  }

  private finalizeGif(src: string, forceBlocked: boolean): void {
    const session = this.gifSessions.get(src);
    if (!session || session.finalized || session.disposed) return;

    session.finalized = true;
    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
      session.timeoutId = undefined;
    }

    const aggregatePrediction = this.createGifAggregatePrediction(src, session, forceBlocked);
    session.aggregatePrediction = aggregatePrediction;
    this.cache.set(src, aggregatePrediction);

    markReceived(src);
    for (const img of this.findImagesBySrc(src)) {
      this.applyGifVerdict(img, src, aggregatePrediction);
    }

    // Safe GIFs play natively (no canvas player), so their decoded bitmaps are dead
    // weight. Release them; a later force-block toggle uses a whole-frame blur that
    // needs no frames (see applyGifVerdict).
    if (!shouldBlock(aggregatePrediction)) {
      this.releaseGifFrames(session.frames);
      session.frames = undefined;
    }

    completeContentTiming(src, {
      status: 'success',
      detectionsCount: aggregatePrediction.predictions.length,
      overlayType: shouldBlock(aggregatePrediction) ? 'segment' : undefined,
    });
  }

  /**
   * Apply a GIF's verdict to one element. Unsafe GIFs are replayed through a
   * canvas player so the displayed frame can use that frame's mask.
   */
  private applyGifVerdict(img: HTMLImageElement, src: string, aggregatePrediction: IImagePrediction): void {
    const session = this.gifSessions.get(src);
    this.clearOverlays(img);

    const hasDetections = aggregatePrediction.predictions.length > 0;
    const blocked = shouldBlock(aggregatePrediction);
    finalizeImageProcessing(img, hasDetections ? 'unsafe' : 'safe');

    if (blocked && session?.frames?.length) {
      gifMaskPlayer.createOrUpdatePlayer(
        img,
        session.frames,
        session.framePredictions,
        aggregatePrediction,
        this.hostSettings,
        session.maskInertia,
      );
    } else if (blocked) {
      // Blocked but the decoded frames are gone (a safe GIF force-blocked via toggle, or
      // an evicted session). A safe verdict has no per-frame detections to mask precisely,
      // so a whole-frame blur is the correct block visual and needs no re-decode.
      this.registerToggle(img, aggregatePrediction);
      applyBlacklistStyling(img, this.hostSettings);
    } else {
      this.registerToggle(img, aggregatePrediction);
    }

    let detectionCount = aggregatePrediction.predictions.length;
    if (aggregatePrediction.forcedVisibility === 'visible') detectionCount = 0;
    else if (aggregatePrediction.forcedVisibility === 'blocked') detectionCount = 1;
    this.badgeCounter.trackDetections(img, src, detectionCount);
  }

  private createGifAggregatePrediction(src: string, session: GifSession, forceBlocked: boolean): IImagePrediction {
    const framePredictions = Array.from(session.framePredictions.values()).sort((a, b) => a.frameIndex - b.frameIndex);
    const firstPrediction = framePredictions[0];
    const firstFrame = session.frames?.[0];
    const width = firstPrediction?.width ?? firstFrame?.bitmap.width ?? 0;
    const height = firstPrediction?.height ?? firstFrame?.bitmap.height ?? 0;

    // Represent the GIF by its single busiest frame rather than summing detections across
    // every frame, so the badge/timing count reflects one frame's worth (not N copies of
    // the same recurring subject). shouldBlock still trips whenever any frame had a hit.
    const peakPrediction = framePredictions.reduce<IGifFramePrediction | undefined>(
      (best, prediction) => (prediction.predictions.length > (best?.predictions.length ?? 0) ? prediction : best),
      undefined,
    );

    return {
      src,
      hostname: this.hostSettings.hostname,
      width,
      height,
      predictions: peakPrediction?.predictions ?? [],
      timestamp: Date.now(),
      cacheMetadata: {
        contentType: 'image/gif',
        createdAt: Date.now(),
        accessedAt: Date.now(),
      },
      maskTransform: firstPrediction?.maskTransform ?? { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
      processingTime: {
        fetchTime: 0,
        decodeTime: 0,
        queueTime: 0,
        inferenceTime: 0,
        e2eTime: 0,
        backend: 'gif-frame',
      },
      forcedVisibility: forceBlocked ? 'blocked' : 'auto',
    };
  }

  private evictGifSessionsIfNeeded(): void {
    let overflow = this.gifSessions.size - MAX_GIF_SESSIONS;
    if (overflow <= 0) return;

    // Reclaim oldest-first, but skip sessions whose frames are still in use: a session that
    // hasn't finalized is mid decode/inference, and a blocked session's frames are being
    // drawn live by gifMaskPlayer. Closing either out from under its owner breaks playback.
    for (const [src, session] of this.gifSessions) {
      if (overflow <= 0) break;
      if (!session.finalized) continue;
      this.retireGifSession(src, session);
      overflow--;
    }
  }

  /**
   * Drop a finalized GIF session and free its decoded frames. A blocked GIF is still on
   * screen via gifMaskPlayer, so degrade it to a frame-free whole-frame blur first: the GIF
   * stays hidden (fail-safe) while the player tears down and stops drawing the frames we're
   * about to close.
   */
  private retireGifSession(src: string, session: GifSession): void {
    const { frames } = session;
    if (session.aggregatePrediction && shouldBlock(session.aggregatePrediction)) {
      session.frames = undefined;
      for (const img of this.findImagesBySrc(src)) {
        this.applyGifVerdict(img, src, session.aggregatePrediction);
      }
    }
    if (session.timeoutId) clearTimeout(session.timeoutId);
    this.releaseGifFrames(frames);
    this.gifSessions.delete(src);
  }

  private fallbackToSingleFrame(img: HTMLImageElement, src: string, session: GifSession): void {
    if (session.timeoutId) clearTimeout(session.timeoutId);
    this.releaseGifFrames(session.frames);
    this.gifSessions.delete(src);
    if (session.disposed) return;
    this.queueInference(img, src);
  }

  private releaseGifFrames(frames: DecodedGifFrame[] | undefined): void {
    frames?.forEach(frame => frame.bitmap.close());
  }

  // ===========================================================================
  // Prediction Application
  // ===========================================================================

  private applyPrediction(img: HTMLImageElement, prediction: IImagePrediction): void {
    const currentSrc = img.currentSrc || img.src;

    // Verify src still matches (handles race where src changed)
    if (currentSrc !== prediction.src) {
      return;
    }

    // Mark that we received the prediction
    markReceived(prediction.src);

    // Track detections synchronously for badge (before async apply)
    let detectionCount = prediction.predictions.length;
    if (prediction.forcedVisibility === 'visible') detectionCount = 0;
    else if (prediction.forcedVisibility === 'blocked') detectionCount = 1;
    this.badgeCounter.trackDetections(img, prediction.src, detectionCount);

    // Fail closed until the overlay paints: apply() waits for the image to
    // load and creates the overlay asynchronously, so a cached-unsafe image
    // would otherwise render raw the whole time (including while streaming in).
    if (detectionCount > 0 && !hasInitialStyling(img)) {
      applyInitialImageStyling(img, this.hostSettings);
    }

    const apply = async () => {
      // Double-check src after any async wait
      const srcNow = img.currentSrc || img.src;
      if (srcNow !== prediction.src) {
        // Responsive images can select a different srcset candidate while
        // decode() is pending without producing another observable attribute
        // mutation. Hand the newly selected resource back to the normal
        // pipeline; otherwise the old verdict is discarded and the element
        // remains under its protective blur forever (notably in Reddit's
        // foreground/background image pair).
        this.process(img);
        return;
      }

      // Clear any existing overlays first (also resets protective styling)
      this.clearOverlays(img);

      const hasDetections = prediction.predictions.length > 0;
      if (hasDetections && prediction.forcedVisibility !== 'visible') {
        applyInitialImageStyling(img, this.hostSettings);
      }
      this.registerToggle(img, prediction);

      // Determine overlay type based on what styling is applied
      let overlayType: string | undefined;

      // Finalize (which strips protective styling) only once the branch's own
      // protection is in place — for masked images that means after the
      // overlay painted, or the unprotected window would reopen
      if (prediction.forcedVisibility === 'blocked') {
        finalizeImageProcessing(img, hasDetections ? 'unsafe' : 'safe');
        applyBlacklistStyling(img, this.hostSettings);
        overlayType = 'blur';
      } else if (prediction.forcedVisibility === 'visible') {
        finalizeImageProcessing(img, hasDetections ? 'unsafe' : 'safe');
        overlayType = undefined; // Whitelisted, no overlay
      } else if (hasDetections) {
        await applyPredictionsStyling([img], [prediction], this.hostSettings);
        finalizeImageProcessing(img, 'unsafe');
        overlayType = 'segment';
      } else {
        finalizeImageProcessing(img, 'safe');
        overlayType = undefined; // No detections, no overlay
      }

      // Log the completion with overlay type
      completeContentTiming(prediction.src, {
        status: 'success',
        detectionsCount: prediction.predictions.length,
        overlayType,
      });
    };

    // Wait for load if needed — use decode() as fallback for cached images
    // where the load event may have already fired before the listener was attached
    if (img.complete && img.naturalWidth > 0) {
      void apply();
    } else {
      let handled = false;
      const onReady = () => {
        if (handled) return;
        handled = true;
        void apply();
      };
      img.decode().then(onReady).catch(onReady);
      img.addEventListener('load', onReady, { once: true });
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private registerToggle(img: HTMLImageElement, prediction: IImagePrediction): void {
    registerQuickToggle(img, predictionToggleRegistration(prediction, this.hostSettings));
  }

  private clearOverlays(img: HTMLImageElement): void {
    gifMaskPlayer.clearPlayer(img);
    imageMaskOverlay.clearMaskOverlay(img);
    unregisterQuickToggle(img);
    resetImageStyling(img);
  }

  private findImagesBySrc(src: string): HTMLImageElement[] {
    const results: HTMLImageElement[] = [];
    const selector = `img.${BLUR_CLASS}, img[${BLACKLIST_ATTR}]`;

    // Query light DOM
    for (const img of document.querySelectorAll<HTMLImageElement>(selector)) {
      const imgSrc = img.currentSrc || img.src;
      if (imgSrc === src) {
        results.push(img);
      }
    }

    // Query only tracked shadow roots (O(shadowRoots) instead of O(allElements))
    for (const shadowRoot of this.knownShadowRoots) {
      // Skip disconnected shadow roots
      if (!shadowRoot.host.isConnected) {
        this.knownShadowRoots.delete(shadowRoot);
        continue;
      }
      for (const img of shadowRoot.querySelectorAll<HTMLImageElement>(selector)) {
        const imgSrc = img.currentSrc || img.src;
        if (imgSrc === src) {
          results.push(img);
        }
      }
    }

    return results;
  }

  // Queries all images on each call. Acceptable for user-initiated toggles (infrequent).
  // Maintaining a src→elements index would require complex cleanup for removed elements.
  private findAllImagesBySrc(src: string): HTMLImageElement[] {
    const results: HTMLImageElement[] = [];

    // Query light DOM
    for (const img of document.querySelectorAll<HTMLImageElement>('img')) {
      const imgSrc = img.currentSrc || img.src;
      if (imgSrc === src) {
        results.push(img);
      }
    }

    // Query only tracked shadow roots
    for (const shadowRoot of this.knownShadowRoots) {
      if (!shadowRoot.host.isConnected) {
        this.knownShadowRoots.delete(shadowRoot);
        continue;
      }
      for (const img of shadowRoot.querySelectorAll<HTMLImageElement>('img')) {
        const imgSrc = img.currentSrc || img.src;
        if (imgSrc === src) {
          results.push(img);
        }
      }
    }

    return results;
  }

  /**
   * Track the shadow root containing this image (if any) for efficient querying.
   * Walks up the DOM tree to find enclosing shadow roots.
   */
  private trackShadowRoot(img: HTMLImageElement): void {
    let node: Node | null = img;
    while (node) {
      const root = node.getRootNode();
      if (root instanceof ShadowRoot) {
        this.knownShadowRoots.add(root);
        // Continue up to find nested shadow roots
        node = root.host;
      } else {
        break;
      }
    }
  }
}
