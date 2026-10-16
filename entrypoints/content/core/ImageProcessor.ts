import { requestImageInference, requestToggleUpdate } from '@/entrypoints/content/communication/sender';
import { isPlaceholderResolution, resolveImageSource, type NaturalSize } from '@/entrypoints/content/core/imageSource';
import { createInferenceTracker } from '@/entrypoints/content/core/inferenceTracker';
import { PredictionCache } from '@/entrypoints/content/core/predictionCache';
import { createGifInspector, type GifInspector } from '@/entrypoints/content/gif/gifInspector';
import { isGifCandidate } from '@/entrypoints/content/gif/gifSupport';
import { gifTransport } from '@/entrypoints/content/gif/gifTransport';
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
  type ProcessedStatus,
} from '@/entrypoints/content/presentation/initialStyling';
import { applyPredictionsStyling } from '@/entrypoints/content/presentation/predictionStyling';
import {
  destroyQuickToggle,
  initQuickToggle,
  predictionToggleRegistration,
  registerQuickToggle,
  unregisterQuickToggle,
} from '@/entrypoints/content/presentation/quickToggle';
import { clearSrcDriftHandler, setSrcDriftHandler } from '@/entrypoints/content/presentation/srcDrift';
import { INFERENCE_PRIORITY } from '@/utils/constants/inference';
import { ATTR, getLogger } from '@/utils/telemetry';
import {
  cancelAllRoundtrips,
  cancelRoundtrip,
  endRoundtrip,
  endRoundtripChild,
  getRoundtripContext,
  roundtripMatches,
  SPAN,
  startRoundtrip,
  startRoundtripChild,
} from '@/utils/telemetry/roundtrip';
import {
  shouldBlock,
  type GifFrameInferenceResult,
  type IHostSettings,
  type IImagePrediction,
  type ImageInferenceResult,
} from '@/utils/types';

import type { BadgeCounter } from '@/entrypoints/content/core/BadgeCounter';

// =============================================================================
// Constants
// =============================================================================

const log = getLogger('ImageProcessor');

const SVG_PATTERN = /\.svg(?:[?#]|$)|image\/svg\+xml/i;
const MAX_CACHE_SIZE = 500;
const SRC_STABILIZATION_DELAY = 150;
const PLACEHOLDER_MAX_NATURAL_PX = 32;

type AppliedOutcome = { kind: 'applied'; overlayType: string | undefined };
type ApplyOutcome = { kind: 'stale' } | { kind: 'drifted' } | AppliedOutcome;

type VerdictPresentation = 'image' | 'gif';

const badgeDetectionCount = (prediction: IImagePrediction): number => {
  if (prediction.forcedVisibility === 'visible') return 0;
  if (prediction.forcedVisibility === 'blocked') return 1;
  return prediction.predictions.length;
};

function waitForImageReady(img: HTMLImageElement): Promise<void> {
  if (img.complete && img.naturalWidth > 0) return Promise.resolve();
  return new Promise(resolve => {
    let handled = false;
    const onReady = () => {
      if (handled) return;
      handled = true;
      resolve();
    };
    img.decode().then(onReady).catch(onReady);
    img.addEventListener('load', onReady, { once: true });
  });
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
  private readonly gifInspector: GifInspector;
  private readonly inference = createInferenceTracker(src => this.handleInferenceFailure(src, 'closed', 'timeout'));
  private readonly loadDriftWatched = new WeakSet<HTMLImageElement>();
  /** Last resolved source seen for an element; filters Reddit's no-op attribute churn. */
  private readonly resolvedSrcByImage = new WeakMap<HTMLImageElement, string>();
  private readonly srcChangeDebounce = new WeakMap<HTMLImageElement, ReturnType<typeof setTimeout>>();
  /** Unloaded copies that deferred to a pending owner and await their own load (see queueInference). */
  private readonly deferredUntilLoad = new WeakSet<HTMLImageElement>();
  private readonly visibilityMap = new WeakMap<HTMLImageElement, boolean>();
  private readonly visibilityObserver: IntersectionObserver;
  private readonly srcDriftHandler = (img: HTMLImageElement): void => this.handleSrcChange(img);

  // Track shadow roots that contain processed images (for efficient querying)
  private readonly knownShadowRoots = new Set<ShadowRoot>();

  constructor(
    private readonly hostSettings: IHostSettings,
    private readonly badgeCounter: BadgeCounter,
  ) {
    initQuickToggle((src, forcedVisibility) => this.handleToggle(src, forcedVisibility));

    this.gifInspector = createGifInspector({
      hostSettings,
      cache: this.cache,
      transport: gifTransport,
      findImages: src => this.findImagesBySrc(src),
      priorityFor: img => this.priorityFor(img),
      isBelowMinSize: (src, img) => this.isBelowMinSizeForSrc(src, img),
      protect: img => this.protect(img),
      present: (img, verdict) => this.applyGifVerdict(img, verdict),
      skip: src => this.finalizeAllImagesForSrc(src, 'skipped'),
      fallback: (img, src) => this.queueInference(img, src),
    });

    // Fail-closed route for srcset re-selection (lightbox resize): the overlay
    // self-clean is the only place that detects it — no attribute mutates, so
    // DomObserver stays silent. handleSrcChange re-blurs and reprocesses.
    setSrcDriftHandler(this.srcDriftHandler);

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
    const src = resolveImageSource(img);
    if (!src) return;
    this.resolvedSrcByImage.set(img, src);
    this.watchSourceDriftOnLoad(img);

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
      this.gifInspector.inspect(img, src);
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
      void this.applyPrediction(img, cached);
      return;
    }

    startRoundtrip(src, { src, hostname: this.hostSettings.hostname, mediaKind: 'image' });

    this.protect(img);

    // Queue for inference (deduped by src)
    this.queueInference(img, src);
  }

  private watchSourceDriftOnLoad(img: HTMLImageElement): void {
    if (this.loadDriftWatched.has(img)) return;
    this.loadDriftWatched.add(img);
    img.addEventListener('load', () => {
      const processedSrc = this.resolvedSrcByImage.get(img);
      if (processedSrc && resolveImageSource(img) !== processedSrc) this.handleSrcChange(img);
    });
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
    const resolvedSrc = resolveImageSource(img);
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

    this.protect(img);

    // Cancel any pending debounce for this image
    const existingTimeout = this.srcChangeDebounce.get(img);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Debounce: wait for src to stabilize before processing
    const timeout = setTimeout(() => {
      this.srcChangeDebounce.delete(img);
      const src = resolveImageSource(img);
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
      if (result.status === 'started') {
        this.inference.started(result.src);
        continue;
      }
      if (result.status === 'error') {
        this.handleInferenceFailure(result.src, 'open', result.reason, result.traceparent);
        continue;
      }
      const pred = result.prediction;
      this.cache.set(pred.src, pred);
      this.inference.settle(pred.src);

      void this.applyPredictionToAllImages(pred, result.traceparent);
    }
  }

  private async applyPredictionToAllImages(prediction: IImagePrediction, traceparent?: string): Promise<void> {
    const tracksRoundtrip = roundtripMatches(prediction.src, traceparent);
    if (tracksRoundtrip) startRoundtripChild(prediction.src, SPAN.apply);
    const outcomes = await Promise.all(
      this.findImagesBySrc(prediction.src).map(img => this.applyPrediction(img, prediction)),
    );
    if (!tracksRoundtrip) return;
    endRoundtripChild(prediction.src, SPAN.apply, { elementCount: outcomes.length });

    const applied = outcomes.find(outcome => outcome.kind === 'applied');
    if (!applied) {
      endRoundtrip(prediction.src, {
        status: 'skipped',
        attributes: { reason: outcomes.length === 0 ? 'no elements' : 'src changed' },
      });
      return;
    }
    endRoundtrip(prediction.src, {
      status: 'success',
      attributes: {
        [ATTR.detectionsCount]: prediction.predictions.length,
        [ATTR.overlayType]: applied.overlayType,
        [ATTR.e2eMs]: prediction.processingTime.e2eTime,
        [ATTR.backend]: prediction.processingTime.backend,
      },
    });
  }

  handleGifFrameResults(results: GifFrameInferenceResult[]): void {
    this.gifInspector.handleFrameResults(results);
  }

  /**
   * Clean up when image removed from DOM.
   */
  handleRemoved(img: HTMLImageElement): void {
    const src = resolveImageSource(img);
    if (src) {
      cancelRoundtrip(src);
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
    clearSrcDriftHandler(this.srcDriftHandler);
    this.visibilityObserver.disconnect();
    this.inference.dispose();
    this.gifInspector.dispose();
    cancelAllRoundtrips('disposed');
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

    if (this.gifInspector.replaceVerdict(src, updated)) {
      for (const img of this.findAllImagesBySrc(src)) {
        this.applyGifVerdict(img, updated);
      }
      return;
    }

    for (const img of this.findAllImagesBySrc(src)) {
      this.badgeCounter.trackDetections(img, src, badgeDetectionCount(updated));
      void this.presentVerdict(img, updated, 'image');
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
    if (this.inference.claim(src, img) === 'defer') {
      this.reprocessDeferredCopyOnLoad(img);
      return;
    }

    const sendRequest = async () => {
      // If src changed before load (common with srcset), reprocess with new src
      const currentSrc = resolveImageSource(img);
      if (currentSrc !== src) {
        this.inference.abandon(src, img);
        // Re-process with the actual loaded URL instead of just aborting
        this.process(img);
        cancelRoundtrip(src);
        return;
      }

      // Skip only if all currently pending elements for this src are below threshold.
      if (this.isBelowMinSizeForSrc(src, img)) {
        this.inference.settle(src, img);
        endRoundtrip(src, { status: 'skipped', attributes: { reason: 'below min size' } });
        this.finalizeAllImagesForSrc(src, 'skipped');
        return;
      }

      if (isPlaceholderResolution(img, this.placeholderLimit())) {
        this.inference.settle(src, img);
        endRoundtrip(src, { status: 'skipped', attributes: { reason: 'placeholder resolution' } });
        this.finalizeAllImagesForSrc(src, 'skipped');
        return;
      }

      try {
        this.inference.sent(src, img);
        await requestImageInference(this.hostSettings.hostname, img, this.priorityFor(img), getRoundtripContext(src));
      } catch (err) {
        if (!this.inference.settle(src, img)) return;
        endRoundtrip(src, { status: 'error', error: err });
        this.finalizeAllImagesForSrc(src, 'skipped');
      }
    };

    const handleError = (reason?: unknown) => {
      if (!this.inference.settle(src, img)) return;
      let error: Error;
      if (reason instanceof Error) {
        error = reason;
      } else if (reason !== undefined) {
        error = new Error(typeof reason === 'string' ? reason : JSON.stringify(reason));
      } else {
        error = new Error('Image failed to load');
      }
      endRoundtrip(src, { status: 'error', error });
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

  /**
   * An unloaded copy that deferred to another owner may resolve a different currentSrc than the
   * verdict's src (lazy load + srcset picks a larger candidate), and a lazy load fires no attribute
   * mutation, so nothing else would revisit it. Re-entering process() once it has pixels usually
   * finds the verdict for its resolved src already cached.
   */
  private reprocessDeferredCopyOnLoad(img: HTMLImageElement): void {
    const hasPixels = img.complete && img.naturalWidth > 0;
    if (hasPixels || this.deferredUntilLoad.has(img)) return;
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

  private handleInferenceFailure(
    src: string,
    exhaustedMode: 'open' | 'closed',
    reason?: string,
    traceparent?: string,
  ): void {
    const outcome = this.inference.fail(src);
    if (outcome.kind === 'untracked') return;
    const tracksRoundtrip = roundtripMatches(src, traceparent);
    const { attempts } = outcome;

    if (outcome.kind === 'exhausted') {
      if (tracksRoundtrip) {
        endRoundtrip(src, {
          status: 'error',
          error: new Error(`Image inference failed after ${attempts} attempts${reason ? `: ${reason}` : ''}`),
          attributes: { attempts, exhaustedMode },
        });
      }
      if (exhaustedMode === 'closed') {
        log.warn('inference.exhausted.fail_closed', { [ATTR.src]: src, attempts, reason });
        return;
      }
      this.finalizeAllImagesForSrc(src, 'skipped');
      return;
    }
    log.debug('inference.retry', { [ATTR.src]: src, attempt: attempts, reason }, getRoundtripContext(src));

    const candidates = this.findImagesBySrc(src);
    const retryOwner =
      candidates.find(candidate => this.visibilityMap.get(candidate) && candidate.complete) ??
      candidates.find(candidate => candidate.complete) ??
      candidates[0];
    if (retryOwner) this.process(retryOwner);
    else this.inference.settle(src);
  }

  private placeholderLimit(): NaturalSize {
    const { minSize } = this.hostSettings;
    return {
      width: Math.min(PLACEHOLDER_MAX_NATURAL_PX, minSize.width),
      height: Math.min(PLACEHOLDER_MAX_NATURAL_PX, minSize.height),
    };
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

  private priorityFor(img: HTMLImageElement): number {
    const isVisible = this.visibilityMap.get(img) ?? false;
    return isVisible ? INFERENCE_PRIORITY.visibleImage : INFERENCE_PRIORITY.offscreenImage;
  }

  private protect(img: HTMLImageElement): void {
    if (!hasInitialStyling(img)) {
      applyInitialImageStyling(img, this.hostSettings);
    }
  }

  // ===========================================================================
  // Prediction Application
  // ===========================================================================

  private async applyPrediction(img: HTMLImageElement, prediction: IImagePrediction): Promise<ApplyOutcome> {
    const currentSrc = resolveImageSource(img);

    // Verify src still matches (handles race where src changed)
    if (currentSrc !== prediction.src) {
      return { kind: 'stale' };
    }

    const detectionCount = badgeDetectionCount(prediction);
    this.badgeCounter.trackDetections(img, prediction.src, detectionCount);

    // Fail closed until the overlay paints: apply() waits for the image to
    // load and creates the overlay asynchronously, so a cached-unsafe image
    // would otherwise render raw the whole time (including while streaming in).
    if (detectionCount > 0 && !hasInitialStyling(img)) {
      applyInitialImageStyling(img, this.hostSettings);
    }

    await waitForImageReady(img);

    // Double-check src after any async wait
    const srcNow = resolveImageSource(img);
    if (srcNow !== prediction.src) {
      // Responsive images can select a different srcset candidate while
      // decode() is pending without producing another observable attribute
      // mutation. Hand the newly selected resource back to the normal
      // pipeline; otherwise the old verdict is discarded and the element
      // remains under its protective blur forever (notably in Reddit's
      // foreground/background image pair).
      this.process(img);
      return { kind: 'drifted' };
    }

    return this.presentVerdict(img, prediction, 'image');
  }

  /**
   * Unsafe GIFs are replayed through a canvas player so the displayed frame can use that frame's mask.
   */
  private applyGifVerdict(img: HTMLImageElement, verdict: IImagePrediction): void {
    this.badgeCounter.trackDetections(img, verdict.src, badgeDetectionCount(verdict));
    void this.presentVerdict(img, verdict, 'gif');
  }

  /**
   * Replace whatever an element currently shows with the visual for `prediction`. Finalizing
   * strips protective styling, so every blocked branch finalizes only where its own protection
   * lands in the same task, and the async mask overlay keeps the initial blur until it paints.
   * GIFs whose decoded frames are gone (a safe GIF force-blocked via toggle, or an evicted
   * session) get a whole-frame blur: there are no per-frame detections to mask precisely.
   */
  private async presentVerdict(
    img: HTMLImageElement,
    prediction: IImagePrediction,
    presentation: VerdictPresentation,
  ): Promise<AppliedOutcome> {
    this.clearOverlays(img);
    const status: ProcessedStatus = prediction.predictions.length > 0 ? 'unsafe' : 'safe';

    if (!shouldBlock(prediction)) {
      this.registerToggle(img, prediction);
      finalizeImageProcessing(img, status);
      return { kind: 'applied', overlayType: undefined };
    }

    const playback = presentation === 'gif' ? this.gifInspector.playbackFor(prediction.src) : undefined;
    if (playback) {
      finalizeImageProcessing(img, status);
      gifMaskPlayer.createOrUpdatePlayer(
        img,
        playback.frames,
        playback.framePredictions,
        prediction,
        this.hostSettings,
        playback.maskInertia,
      );
      return { kind: 'applied', overlayType: 'segment' };
    }

    if (presentation === 'gif' || prediction.forcedVisibility === 'blocked') {
      this.registerToggle(img, prediction);
      finalizeImageProcessing(img, status);
      applyBlacklistStyling(img, this.hostSettings);
      return { kind: 'applied', overlayType: 'blur' };
    }

    applyInitialImageStyling(img, this.hostSettings);
    this.registerToggle(img, prediction);
    await applyPredictionsStyling([img], [prediction], this.hostSettings);
    finalizeImageProcessing(img, 'unsafe');
    return { kind: 'applied', overlayType: 'segment' };
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
    return this.collectMatchingImages(`img.${BLUR_CLASS}, img[${BLACKLIST_ATTR}]`, src);
  }

  // Queries all images on each call. Acceptable for user-initiated toggles (infrequent).
  // Maintaining a src→elements index would require complex cleanup for removed elements.
  private findAllImagesBySrc(src: string): HTMLImageElement[] {
    return this.collectMatchingImages('img', src);
  }

  private collectMatchingImages(selector: string, src: string): HTMLImageElement[] {
    const roots: ParentNode[] = [document];
    for (const shadowRoot of this.knownShadowRoots) {
      if (!shadowRoot.host.isConnected) {
        this.knownShadowRoots.delete(shadowRoot);
        continue;
      }
      roots.push(shadowRoot);
    }
    const results: HTMLImageElement[] = [];
    for (const root of roots) {
      for (const img of root.querySelectorAll<HTMLImageElement>(selector)) {
        if (resolveImageSource(img) === src) results.push(img);
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
