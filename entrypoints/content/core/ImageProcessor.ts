import {
  requestGifFrameInference,
  requestImageInference,
  requestToggleUpdate,
} from '@/entrypoints/content/communication/sender';
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
  registerQuickToggle,
  unregisterQuickToggle,
} from '@/entrypoints/content/presentation/quickToggle';
import { IS_CHROME } from '@/utils/constants/environment';
import { GIF_MIN_MASK_INERTIA } from '@/utils/constants/gif';
import { logger } from '@/utils/logger';
import {
  cancelContentTiming,
  completeContentTiming,
  markReceived,
  markSent,
  startContentTiming,
} from '@/utils/logging';
import { waitForMessageChannel } from '@/utils/messaging/content';
import { shouldBlock, type IGifFramePrediction, type IHostSettings, type IImagePrediction } from '@/utils/types';

import type { BadgeCounter } from '@/entrypoints/content/core/BadgeCounter';
import type { PredictionSource } from '@/utils/logging/types';

// =============================================================================
// Constants
// =============================================================================

const SVG_PATTERN = /\.svg(?:[?#]|$)|image\/svg\+xml/i;
const MAX_CACHE_SIZE = 500;
const SRC_STABILIZATION_DELAY = 150;

const PRIORITY_VISIBLE = 10;
const PRIORITY_OFFSCREEN = 0;

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
  private readonly cache = new Map<string, IImagePrediction>();
  // Srcs whose cache entry came from IndexedDB seeding (vs fresh inference) — kept so
  // wide events can report where an applied verdict actually came from.
  private readonly seededSrcs = new Set<string>();
  private readonly gifSessions = new Map<string, GifSession>();
  private readonly pendingInference = new Set<string>();
  private readonly srcChangeDebounce = new WeakMap<HTMLImageElement, ReturnType<typeof setTimeout>>();
  private readonly visibilityMap = new WeakMap<HTMLImageElement, boolean>();
  private readonly visibilityObserver: IntersectionObserver;

  // Track shadow roots that contain processed images (for efficient querying)
  private readonly knownShadowRoots = new Set<ShadowRoot>();

  constructor(
    private readonly hostSettings: IHostSettings,
    private readonly badgeCounter: BadgeCounter,
  ) {
    initQuickToggle((src, forcedVisibility) => this.handleToggle(src, forcedVisibility));

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
      startContentTiming(src, this.hostSettings.hostname);
      this.applyPrediction(img, cached, this.seededSrcs.has(src) ? 'db-cache' : 'memory-cache');
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
      this.addToCache(pred.src, pred);
      this.seededSrcs.add(pred.src);
    }
  }

  /**
   * Handle predictions from background. Caches and applies to matching images.
   */
  handlePredictions(predictions: IImagePrediction[]): void {
    for (const pred of predictions) {
      this.addToCache(pred.src, pred);
      this.seededSrcs.delete(pred.src);
      this.pendingInference.delete(pred.src);

      // Find and update all matching images
      const images = this.findImagesBySrc(pred.src);
      for (const img of images) {
        this.applyPrediction(img, pred, 'inference');
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
    this.visibilityObserver.disconnect();
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
      registerQuickToggle(img, updated, this.hostSettings);
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
    // Dedupe by src - only one request per unique src
    if (this.pendingInference.has(src)) {
      return;
    }

    // Mark pending immediately to prevent duplicate load handlers
    this.pendingInference.add(src);

    const sendRequest = async () => {
      // If src changed before load (common with srcset), reprocess with new src
      const currentSrc = img.currentSrc || img.src;
      if (currentSrc !== src) {
        this.pendingInference.delete(src);
        // Re-process with the actual loaded URL instead of just aborting
        this.process(img);
        cancelContentTiming(src);
        return;
      }

      // Skip only if all currently pending elements for this src are below threshold.
      if (this.isBelowMinSizeForSrc(src, img)) {
        this.pendingInference.delete(src);
        completeContentTiming(src, { status: 'skipped', reason: 'below-min-size' });
        this.finalizeAllImagesForSrc(src, 'skipped');
        return;
      }

      try {
        markSent(src);
        const isVisible = this.visibilityMap.get(img) ?? false;
        const priority = isVisible ? PRIORITY_VISIBLE : PRIORITY_OFFSCREEN;
        await requestImageInference(this.hostSettings.hostname, img, priority);
      } catch (err) {
        this.pendingInference.delete(src);
        completeContentTiming(src, {
          status: 'error',
          reason: 'send-failed',
          error: err instanceof Error ? err : undefined,
        });
        this.finalizeAllImagesForSrc(src, 'skipped');
      }
    };

    const handleError = (reason: unknown, cause: 'decode-rejected' | 'load-error') => {
      this.pendingInference.delete(src);
      let error: Error;
      if (reason instanceof Error) {
        error = reason;
      } else if (reason !== undefined) {
        error = new Error(typeof reason === 'string' ? reason : JSON.stringify(reason));
      } else {
        error = new Error('Image failed to load');
      }
      completeContentTiming(src, { status: 'error', reason: cause, error });
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
      const onFail = (reason: unknown, cause: 'decode-rejected' | 'load-error') => {
        if (handled) return;
        handled = true;
        handleError(reason, cause);
      };

      img
        .decode()
        .then(onReady)
        .catch((reason: unknown) => onFail(reason, 'decode-rejected'));
      img.addEventListener('load', onReady, { once: true });
      img.addEventListener('error', () => onFail(new Error(`Load error: ${img.src.substring(0, 80)}`), 'load-error'), {
        once: true,
      });
    }
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
      completeContentTiming(src, { status: 'skipped', reason: 'below-min-size' });
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
    const priority = isVisible ? PRIORITY_VISIBLE : PRIORITY_OFFSCREEN;

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
   * Aggregate per-frame verdicts. Finalization waits until every sampled frame has
   * returned (or failed); the fail-closed timeout covers verdicts that never arrive.
   */
  handleGifFramePredictions(predictions: IGifFramePrediction[]): void {
    for (const pred of predictions) {
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
    this.addToCache(src, aggregatePrediction);

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
      source: 'inference',
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
      registerQuickToggle(img, aggregatePrediction, this.hostSettings);
      applyBlacklistStyling(img, this.hostSettings);
    } else {
      registerQuickToggle(img, aggregatePrediction, this.hostSettings);
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

  private applyPrediction(img: HTMLImageElement, prediction: IImagePrediction, source: PredictionSource): void {
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

    const apply = async () => {
      // Double-check src after any async wait
      const srcNow = img.currentSrc || img.src;
      if (srcNow !== prediction.src) {
        return;
      }

      // Clear any existing overlays first
      this.clearOverlays(img);

      const hasDetections = prediction.predictions.length > 0;
      registerQuickToggle(img, prediction, this.hostSettings);

      // Finalize processing with status based on AI result (not forced visibility)
      finalizeImageProcessing(img, hasDetections ? 'unsafe' : 'safe');

      // Determine overlay type based on what styling is applied
      let overlayType: string | undefined;

      if (prediction.forcedVisibility === 'blocked') {
        applyBlacklistStyling(img, this.hostSettings);
        overlayType = 'blur';
      } else if (prediction.forcedVisibility === 'visible') {
        overlayType = undefined; // Whitelisted, no overlay
      } else if (hasDetections) {
        await applyPredictionsStyling([img], [prediction], this.hostSettings);
        overlayType = 'segment';
      } else {
        overlayType = undefined; // No detections, no overlay
      }

      // Log the completion with overlay type
      completeContentTiming(prediction.src, {
        status: 'success',
        source,
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
  // Cache Management
  // ===========================================================================

  private addToCache(src: string, prediction: IImagePrediction): void {
    this.cache.set(src, prediction);

    // Evict oldest entries if over limit
    if (this.cache.size > MAX_CACHE_SIZE) {
      const keysToDelete = this.cache.size - MAX_CACHE_SIZE;
      const iterator = this.cache.keys();
      for (let i = 0; i < keysToDelete; i++) {
        const key = iterator.next().value;
        if (key) this.cache.delete(key);
      }
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

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
