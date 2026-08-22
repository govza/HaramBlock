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
  PROCESSED_ATTR_MAP,
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

const SVG_PATTERN = /\.svg(?:[?#]|$)|image\/svg\+xml/i;
const MAX_CACHE_SIZE = 500;
const SRC_STABILIZATION_DELAY = 150;
const IMAGE_INFERENCE_TIMEOUT_MS = 20_000;
const MAX_IMAGE_INFERENCE_ATTEMPTS = 2;

const MAX_GIF_SESSIONS = 500;
const GIF_VERDICT_TIMEOUT_MS = 20000;

interface GifSession {
  sessionId: string;
  frameCount: number;
  received: number;
  failedFrames: number;
  frames?: DecodedGifFrame[];
  framePredictions: Map<number, IGifFramePrediction>;
  maskInertia: number;
  aggregatePrediction?: IImagePrediction;
  finalized: boolean;
  disposed: boolean;
  timeoutId?: ReturnType<typeof setTimeout>;
}

export class ImageProcessor {
  private readonly cache = new PredictionCache(MAX_CACHE_SIZE);
  private readonly gifSessions = new Map<string, GifSession>();

  private readonly pendingInference = new Map<string, HTMLImageElement>();
  private readonly pendingInferenceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inferenceAttempts = new Map<string, number>();

  private readonly resolvedSrcByImage = new WeakMap<HTMLImageElement, string>();
  private readonly srcChangeDebounce = new WeakMap<HTMLImageElement, ReturnType<typeof setTimeout>>();
  private readonly visibilityMap = new WeakMap<HTMLImageElement, boolean>();
  private readonly visibilityObserver: IntersectionObserver;

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

  process(img: HTMLImageElement): void {
    const src = img.currentSrc || img.src;
    if (!src) return;
    if (this.isConverged(img, src)) return;
    const previousSrc = this.resolvedSrcByImage.get(img);
    if (previousSrc !== undefined && previousSrc !== src) {
      this.handleSrcChange(img);
      return;
    }
    this.resolvedSrcByImage.set(img, src);

    this.visibilityObserver.observe(img);
    this.trackShadowRoot(img);

    if (SVG_PATTERN.test(src)) {
      finalizeImageProcessing(img, 'skipped');
      return;
    }

    if (this.hostSettings.policy.behavior === 'blacklist') {
      if (hasBlacklistStyling(img)) {
        return;
      }

      this.clearOverlays(img);
      applyBlacklistStyling(img, this.hostSettings);
      this.badgeCounter.trackDetections(img, src, 1);
      return;
    }

    const { targets } = this.hostSettings.policy;
    if (isGifCandidate(src, img.dataset.contentType)) {
      if (!targets.gif) return;
      this.processGif(img, src);
      return;
    }
    if (!targets.image) return;

    if (this.hasAnyOverlay(img)) {
      const cached = this.cache.get(src);
      if (cached) {
        finalizeImageProcessing(img, cached.predictions.length > 0 ? 'unsafe' : 'safe');
      }
      return;
    }

    const cached = this.cache.get(src);
    if (cached) {
      this.applyPrediction(img, cached);
      return;
    }

    startContentTiming(src, this.hostSettings.hostname);

    if (!hasInitialStyling(img)) {
      applyInitialImageStyling(img, this.hostSettings);
    }

    this.queueInference(img, src);
  }

  processAll(images: HTMLImageElement[]): void {
    for (const img of images) {
      this.process(img);
    }
  }

  handleSrcChange(img: HTMLImageElement): void {
    const resolvedSrc = img.currentSrc || img.src;
    const previousSrc = this.resolvedSrcByImage.get(img);
    if (resolvedSrc === previousSrc) {
      return;
    }
    if (resolvedSrc) this.resolvedSrcByImage.set(img, resolvedSrc);
    else this.resolvedSrcByImage.delete(img);

    this.clearOverlays(img);

    if (!hasInitialStyling(img)) {
      applyInitialImageStyling(img, this.hostSettings);
    }

    const existingTimeout = this.srcChangeDebounce.get(img);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    const timeout = setTimeout(() => {
      this.srcChangeDebounce.delete(img);
      const src = img.currentSrc || img.src;
      if (src) {
        this.process(img);
      }
    }, SRC_STABILIZATION_DELAY);

    this.srcChangeDebounce.set(img, timeout);
  }

  seedCache(predictions: IImagePrediction[]): void {
    for (const pred of predictions) {
      this.cache.set(pred.src, pred);
    }
  }

  handleInferenceResults(results: ImageInferenceResult[]): void {
    for (const result of results) {
      if (result.status === 'error') {
        this.handleInferenceFailure(result.src, result.reason);
        continue;
      }
      const pred = result.prediction;
      this.cache.set(pred.src, pred);
      this.clearPendingInference(pred.src, undefined, true);

      const images = this.findImagesBySrc(pred.src);
      for (const img of images) {
        this.applyPrediction(img, pred);
      }
    }
  }

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

  dispose(): void {
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

      this.registerToggle(img, updated);
      this.badgeCounter.trackDetections(img, src, detectionCount);
    }
  }

  private isConverged(img: HTMLImageElement, src: string): boolean {
    if (this.resolvedSrcByImage.get(img) !== src) return false;
    if (img.hasAttribute(PROCESSED_ATTR_MAP.safe) || img.hasAttribute(PROCESSED_ATTR_MAP.skipped)) return true;
    if (!img.hasAttribute(PROCESSED_ATTR_MAP.unsafe)) return false;

    return this.hasAnyOverlay(img) || hasBlacklistStyling(img) || this.cache.get(src)?.forcedVisibility === 'visible';
  }

  private hasAnyOverlay(img: HTMLImageElement): boolean {
    return Boolean(imageMaskOverlay.hasMaskOverlay(img) || gifMaskPlayer.hasPlayer(img));
  }

  private queueInference(img: HTMLImageElement, src: string): void {
    const owner = this.pendingInference.get(src);
    if (owner && owner.isConnected) {
      const ownerReady = owner.complete && owner.naturalWidth > 0;
      const imgReady = img.complete && img.naturalWidth > 0;

      if (ownerReady || !imgReady) return;
    }

    if (!(img.complete && img.naturalWidth > 0)) {
      if (img.complete) {
        this.clearPendingInference(src, undefined, true);
        completeContentTiming(src, { status: 'error', error: new Error(`Load error: ${src.substring(0, 80)}`) });

        finalizeImageProcessing(img, 'skipped');
      }
      return;
    }

    this.pendingInference.set(src, img);

    const sendRequest = async () => {
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

    void sendRequest();
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

  private finalizeAllImagesForSrc(src: string, status: 'safe' | 'unsafe' | 'skipped'): void {
    const images = this.findImagesBySrc(src);
    for (const img of images) {
      finalizeImageProcessing(img, status);
    }
  }

  private processGif(img: HTMLImageElement, src: string): void {
    const existing = this.gifSessions.get(src);
    if (existing) {
      if (existing.finalized && existing.aggregatePrediction) {
        this.applyGifVerdict(img, src, existing.aggregatePrediction);
      } else if (!hasInitialStyling(img)) {
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

    if (!decoded) {
      this.fallbackToSingleFrame(img, src, session);
      return;
    }

    session.frames = decoded.frames;
    const totalFrames = decoded.frames.length;
    const inferenceIndices = sampleFrameIndices(totalFrames, gifInferenceFrameCap(totalFrames));
    session.frameCount = inferenceIndices.length;
    session.maskInertia = Math.max(GIF_MIN_MASK_INERTIA, Math.ceil(totalFrames / Math.max(1, inferenceIndices.length)));
    markSent(src);

    const isVisible = this.visibilityMap.get(img) ?? false;
    const priority = isVisible ? INFERENCE_PRIORITY.visibleImage : INFERENCE_PRIORITY.offscreenImage;

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

    for (const [src, session] of this.gifSessions) {
      if (overflow <= 0) break;
      if (!session.finalized) continue;
      this.retireGifSession(src, session);
      overflow--;
    }
  }

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

  private applyPrediction(img: HTMLImageElement, prediction: IImagePrediction): void {
    const currentSrc = img.currentSrc || img.src;

    if (currentSrc !== prediction.src) {
      return;
    }

    markReceived(prediction.src);

    let detectionCount = prediction.predictions.length;
    if (prediction.forcedVisibility === 'visible') detectionCount = 0;
    else if (prediction.forcedVisibility === 'blocked') detectionCount = 1;
    this.badgeCounter.trackDetections(img, prediction.src, detectionCount);

    if (detectionCount > 0 && !hasInitialStyling(img)) {
      applyInitialImageStyling(img, this.hostSettings);
    }

    const apply = async () => {
      const srcNow = img.currentSrc || img.src;
      if (srcNow !== prediction.src) {
        this.process(img);
        return;
      }

      this.clearOverlays(img);

      const hasDetections = prediction.predictions.length > 0;
      if (hasDetections && prediction.forcedVisibility !== 'visible') {
        applyInitialImageStyling(img, this.hostSettings);
      }
      this.registerToggle(img, prediction);

      let overlayType: string | undefined;

      if (prediction.forcedVisibility === 'blocked') {
        finalizeImageProcessing(img, hasDetections ? 'unsafe' : 'safe');
        applyBlacklistStyling(img, this.hostSettings);
        overlayType = 'blur';
      } else if (prediction.forcedVisibility === 'visible') {
        finalizeImageProcessing(img, hasDetections ? 'unsafe' : 'safe');
        overlayType = undefined;
      } else if (hasDetections) {
        await applyPredictionsStyling([img], [prediction], this.hostSettings);
        finalizeImageProcessing(img, 'unsafe');
        overlayType = 'segment';
        if (!this.hasAnyOverlay(img) && !hasBlacklistStyling(img)) {
          applyBlacklistStyling(img, this.hostSettings);
          overlayType = 'blur';
        }
      } else {
        finalizeImageProcessing(img, 'safe');
        overlayType = undefined;
      }

      completeContentTiming(prediction.src, {
        status: 'success',
        detectionsCount: prediction.predictions.length,
        overlayType,
      });
    };

    if (img.complete) {
      if (img.naturalWidth > 0) {
        void apply();
      } else {
        completeContentTiming(prediction.src, {
          status: 'error',
          error: new Error(`Load error: ${prediction.src.substring(0, 80)}`),
        });
        finalizeImageProcessing(img, 'skipped');
      }
    }
  }

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

    for (const img of document.querySelectorAll<HTMLImageElement>(selector)) {
      const imgSrc = img.currentSrc || img.src;
      if (imgSrc === src) {
        results.push(img);
      }
    }

    for (const shadowRoot of this.knownShadowRoots) {
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

  private findAllImagesBySrc(src: string): HTMLImageElement[] {
    const results: HTMLImageElement[] = [];

    for (const img of document.querySelectorAll<HTMLImageElement>('img')) {
      const imgSrc = img.currentSrc || img.src;
      if (imgSrc === src) {
        results.push(img);
      }
    }

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

  private trackShadowRoot(img: HTMLImageElement): void {
    let node: Node | null = img;
    while (node) {
      const root = node.getRootNode();
      if (root instanceof ShadowRoot) {
        this.knownShadowRoots.add(root);

        node = root.host;
      } else {
        break;
      }
    }
  }
}
