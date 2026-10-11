import {
  cancelVideoSessionInference,
  requestCachedVideoPredictions,
  requestVideoFrameInference,
  requestVideoToggleUpdate,
} from '@/entrypoints/content/communication/sender';
import {
  clearProcessedStatus,
  PROCESSED_ATTR_MAP,
  type ProcessedStatus,
} from '@/entrypoints/content/presentation/initialStyling';
import { registerQuickToggle, unregisterQuickToggle } from '@/entrypoints/content/presentation/quickToggle';
import { LiveSampler } from '@/entrypoints/content/video/live/liveSampler';
import { createLoopRestartDetector, loopingMediaOf } from '@/entrypoints/content/video/loopClock';
import { MaskPresenter } from '@/entrypoints/content/video/presenter/maskPresenter';
import {
  captureFrameBitmap,
  captureThumbnailBitmap,
  currentInferenceCaptureSize,
  releaseCorsVideoCache,
  type CaptureResult,
} from '@/entrypoints/content/video/sampling/capture';
import { PermanentFrameTransferError } from '@/entrypoints/content/video/sampling/transfer';
import { ForcedPresentation } from '@/entrypoints/content/video/session/forcedPresentation';
import { SESSION_ID_ATTR, SESSION_SRC_ATTR, VIDEO_TAP_ATTR } from '@/entrypoints/content/video/session/markers';
import { toVerdictCacheKey } from '@/entrypoints/content/video/session/verdictCacheKey';
import {
  createVideoSession,
  reduce,
  type SessionEffect,
  type SessionEvent,
  type SessionStatus,
  verdictOptionsOf,
} from '@/entrypoints/content/video/session/videoSession';
import { resolveVideoSource, type ResolvedVideoSource } from '@/entrypoints/content/video/session/videoSource';
import { isVideoNearViewport, ViewportSuspension } from '@/entrypoints/content/video/session/viewportSuspension';
import { applyWholeBlur, clearWholeBlur } from '@/entrypoints/content/video/session/wholeBlur';
import { openLookahead, type LookaheadInferenceRequest } from '@/entrypoints/content/video/tap/lookaheadClient';
import { chooseTap } from '@/entrypoints/content/video/tap/tapChoice';
import { VerdictInterpreter } from '@/entrypoints/content/video/timeline/verdictInterpreter';
import { INFERENCE_PRIORITY } from '@/utils/constants/inference';
import {
  livenessOfDuration,
  type AnalysisStat,
  type InferredSample,
  type StoredSample,
  type UnreachableReason,
} from '@/utils/lookahead/ports';
import { generateNonce } from '@/utils/nonce';
import { strictnessToScoreThreshold } from '@/utils/scoreThreshold';
import { ATTR, getLogger, METRIC, recordCounter, recordHistogram } from '@/utils/telemetry';
import { SPAN, startUmbrellaSession } from '@/utils/telemetry/roundtrip';

import type { SessionHandle } from '@/entrypoints/content/video/session/handle';
import type { VerdictEntry } from '@/entrypoints/content/video/timeline/verdictTimeline';
import type { TapKind } from '@/utils/lookahead/protocol';
import type {
  FrameInferenceResult,
  FrameSampleKind,
  ForcedVisibility,
  IFramePrediction,
  IHostSettings,
} from '@/utils/types';

const log = getLogger('videoSession:registry');

const STATUS_TO_PROCESSED: Record<SessionStatus, ProcessedStatus> = {
  safe: 'safe',
  unsafe: 'unsafe',
  skipped: 'skipped',
};

const THUMBNAIL_FRAME_INDEX = -1;
const PROGRESS_INTERVAL_MS = 250;
const SAME_MEDIA_DURATION_TOLERANCE_SEC = 1;
const LOOKAHEAD_INFERENCE_TIMEOUT_MS = 30_000;
const SUSPICION_RATIO = 0.5;

const FAILURE_STAGE = { unitDemuxFailed: 'demux', decodeFailed: 'decode', cacheReadFailed: 'cache' } as const;

const scoreThresholdOf = (handle: SessionHandle): number => strictnessToScoreThreshold(handle.hostSettings.strictness);

const toEntry = (timestampSec: number, sample: InferredSample): VerdictEntry => ({
  timestampSec,
  unsafe: sample.predictions.length > 0,
  predictions: sample.predictions,
  maskTransform: sample.input.maskTransform,
  width: sample.input.width,
  height: sample.input.height,
});

const toInferred = (prediction: IFramePrediction): InferredSample => ({
  predictions: prediction.predictions ?? [],
  input: { width: prediction.width, height: prediction.height, maskTransform: prediction.maskTransform },
  topUnsafeScore: prediction.topUnsafeScore ?? 0,
});

function isSameVideoSource(handle: SessionHandle, source: ResolvedVideoSource): boolean {
  return source.srcObject
    ? handle.srcObject === source.srcObject
    : handle.srcObject === null && handle.src === source.url;
}

function continuesSameMedia(handle: SessionHandle, source: ResolvedVideoSource): boolean {
  return (
    handle.state.phase === 'active' &&
    handle.srcObject === null &&
    source.srcObject === null &&
    handle.cacheKey !== '' &&
    toVerdictCacheKey(source.url) === handle.cacheKey
  );
}

const documentVisible = (): boolean => globalThis.document?.visibilityState !== 'hidden';

interface PendingAttachment {
  hostSettings: IHostSettings;
  cancel: () => void;
}

class VideoSessionRegistry {
  private readonly byId = new Map<string, SessionHandle>();
  private readonly byVideo = new WeakMap<HTMLVideoElement, SessionHandle>();
  private readonly pendingByVideo = new Map<HTMLVideoElement, PendingAttachment>();
  private readonly settingsByVideo = new WeakMap<HTMLVideoElement, IHostSettings>();
  private readonly userToggledCacheKeys = new WeakMap<HTMLVideoElement, string>();
  private readonly unsafeCacheKeys = new Set<string>();
  private documentVisibilityBound = false;

  private readonly forced = new ForcedPresentation({
    attach: (video, hostSettings) => this.attach(video, hostSettings),
    disposeSession: video => {
      const handle = this.byVideo.get(video);
      if (handle) this.dispatch(handle, { type: 'dispose' });
    },
    registerToggle: (video, hostSettings, forcedVisibility, hasDetections, unprocessed) =>
      this.registerToggle(video, hostSettings, forcedVisibility, hasDetections, unprocessed),
  });

  private readonly suspension = new ViewportSuspension({
    handleFor: video => this.byVideo.get(video),
    suspendedChanged: handle => this.applyVisibility(handle),
  });

  attach(video: HTMLVideoElement, hostSettings: IHostSettings): void {
    this.sweepDisconnected();
    this.bindDocumentVisibility();
    this.settingsByVideo.set(video, hostSettings);
    const source = resolveVideoSource(video);
    if (!source) {
      this.awaitResolvedSource(video, hostSettings);
      return;
    }
    this.pendingByVideo.get(video)?.cancel();
    if (this.forced.reconcile(video, source, hostSettings)) return;

    const existing = this.byVideo.get(video);
    if (existing && existing.state.phase !== 'disposed') {
      if (isSameVideoSource(existing, source)) {
        existing.hostSettings = hostSettings;
        return;
      }
      if (continuesSameMedia(existing, source)) {
        existing.hostSettings = hostSettings;
        this.changeSource(existing, source);
        return;
      }
    }
    if (existing) this.dispose(video);

    const handle = this.createHandle(video, source, hostSettings);
    this.byId.set(handle.sessionId, handle);
    this.byVideo.set(video, handle);
    video.setAttribute(SESSION_SRC_ATTR, handle.src);
    video.setAttribute(SESSION_ID_ATTR, handle.sessionId);
    this.registerToggle(video, hostSettings, 'auto', false);

    const born = createVideoSession({ unsafeSeen: this.unsafeCacheKeys.has(handle.cacheKey) });
    handle.state = born.state;
    this.execute(handle, born.effects);

    this.bindMediaEvents(handle);
    this.suspension.observe(handle);
    this.applyVisibility(handle);
    this.queueThumbnail(handle);
    this.openTap(handle, source);
    this.restoreForcedVisibility(handle);
  }

  private changeSource(handle: SessionHandle, source: ResolvedVideoSource): void {
    const { video } = handle;
    log.info('video.session.source_changed', { [ATTR.sessionId]: handle.sessionId, [ATTR.src]: source.url });
    handle.src = source.url;
    handle.verifyMediaOnDuration = handle.mediaDurationSec !== null;
    video.setAttribute(SESSION_SRC_ATTR, handle.src);
    this.dispatch(handle, {
      type: 'sourceChanged',
      coverageAheadSec: this.coverageAheadOf(handle, video.currentTime),
    });
  }

  private restartIfDifferentMedia(handle: SessionHandle): boolean {
    const before = handle.mediaDurationSec;
    const now = handle.video.duration;
    if (!Number.isFinite(now)) return false;
    handle.mediaDurationSec = now;
    if (!handle.verifyMediaOnDuration || before === null) return false;
    handle.verifyMediaOnDuration = false;
    if (Math.abs(now - before) <= SAME_MEDIA_DURATION_TOLERANCE_SEC) return false;
    const settings = handle.hostSettings;
    this.unsafeCacheKeys.delete(handle.cacheKey);
    this.dispose(handle.video);
    this.attach(handle.video, settings);
    return true;
  }

  private reopenTap(handle: SessionHandle): void {
    handle.lookahead?.close();
    handle.lookahead = null;
    handle.tap = null;
    handle.video.removeAttribute(VIDEO_TAP_ATTR);
    const source = resolveVideoSource(handle.video);
    if (source) this.openTap(handle, source);
  }

  private createHandle(video: HTMLVideoElement, source: ResolvedVideoSource, hostSettings: IHostSettings) {
    const sessionId = generateNonce();
    const interpreter = new VerdictInterpreter();
    const handle: SessionHandle = {
      sessionId,
      video,
      srcObject: source.srcObject,
      src: source.url || `srcobject:${sessionId}`,
      cacheKey: toVerdictCacheKey(source.url),
      trace: startUmbrellaSession(SPAN.videoSession, {
        [ATTR.src]: source.url,
        [ATTR.hostname]: hostSettings.hostname,
        [ATTR.mediaKind]: 'video',
      }),
      hostSettings,
      state: createVideoSession().state,
      interpreter,
      presenter: new MaskPresenter({
        video,
        interpreter,
        verdictOptions: () => verdictOptionsOf(handle.state),
        masking: () => handle.hostSettings.masking,
        onPresented: unsafe => this.dispatch(handle, { type: 'presented', unsafe }),
        onFrame: mediaTimeSec => this.onPresentedFrame(handle, mediaTimeSec),
      }),
      live: new LiveSampler({ video, sample: timestampSec => void this.sendLiveSample(handle, timestampSec) }),
      lookahead: null,
      mediaDurationSec: Number.isFinite(video.duration) ? video.duration : null,
      verifyMediaOnDuration: false,
      tap: null,
      nextFrameIndex: 0,
      pendingLive: new Map(),
      pendingLookahead: new Map(),
      heldSamples: new Map(),
      nextSampleId: 0,
      removeListeners: () => {},
      suspended: !isVideoNearViewport(video),
      suspendGrace: null,
      lastProgressAt: Number.NEGATIVE_INFINITY,
      lastFrameAt: null,
      liveMaskingSince: null,
      liveMaskingMs: 0,
    };
    return handle;
  }

  handleResults(results: FrameInferenceResult[]): void {
    this.sweepDisconnected();
    for (const result of results) {
      const sessionId = result.status === 'error' ? result.sessionId : result.prediction.sessionId;
      const frameIndex = result.status === 'error' ? result.frameIndex : result.prediction.frameIndex;
      const handle = this.byId.get(sessionId);
      if (!handle) continue;
      const prediction = result.status === 'ok' ? result.prediction : null;
      const lookahead = handle.pendingLookahead.get(frameIndex);
      if (lookahead) {
        handle.pendingLookahead.delete(frameIndex);
        lookahead(prediction ? toInferred(prediction) : null);
      } else if (frameIndex === THUMBNAIL_FRAME_INDEX) {
        if (prediction) this.applyThumbnail(handle, prediction);
      } else if (handle.pendingLive.has(frameIndex)) {
        const pending = handle.pendingLive.get(frameIndex);
        handle.pendingLive.delete(frameIndex);
        if (pending) {
          recordHistogram(METRIC.inferenceRoundtripMs, performance.now() - pending.sentAt, {
            [ATTR.sessionId]: handle.sessionId,
            [ATTR.mediaKind]: 'frame',
          });
        }
        handle.live.settle();
        if (prediction) this.applyLiveSample(handle, prediction);
      }
    }
  }

  private applyThumbnail(handle: SessionHandle, prediction: IFramePrediction): void {
    const entry = toEntry(0, toInferred(prediction));
    handle.presenter.setThumbnail(entry.unsafe ? entry : null);
    this.dispatch(handle, { type: 'thumbnailVerdict', unsafe: entry.unsafe });
  }

  private applyLiveSample(handle: SessionHandle, prediction: IFramePrediction): void {
    const entry = toEntry(prediction.timestampSec, toInferred(prediction));
    const sampleId = this.holdSample(handle, entry);
    this.dispatch(handle, { type: 'liveSample', sampleId });
  }

  private holdSample(handle: SessionHandle, entry: VerdictEntry): string {
    const sampleId = String(handle.nextSampleId++);
    handle.heldSamples.set(sampleId, entry);
    return sampleId;
  }

  private onLookaheadSample(handle: SessionHandle, sample: StoredSample): void {
    const sampleId = this.holdSample(handle, toEntry(sample.pointUs / 1e6, sample));
    this.dispatch(handle, { type: 'verdict', sampleId });
  }

  dispose(video: HTMLVideoElement): void {
    this.forced.release(video);
    const pending = this.pendingByVideo.get(video);
    pending?.cancel();
    const handle = this.byVideo.get(video);
    if (!handle) {
      if (pending) clearWholeBlur(video);
      return;
    }
    this.dispatch(handle, { type: 'dispose' });
  }

  disposeAll(): void {
    this.forced.releaseAll();
    for (const [video, pending] of [...this.pendingByVideo]) {
      pending.cancel();
      clearWholeBlur(video);
    }
    for (const handle of this.byId.values()) {
      this.dispatch(handle, { type: 'dispose' });
    }
  }

  setForcedVisibility(video: HTMLVideoElement, next: ForcedVisibility): void {
    this.userToggledCacheKeys.set(video, toVerdictCacheKey(resolveVideoSource(video)?.url ?? ''));
    this.applyForcedVisibility(video, next, true);
  }

  private applyForcedVisibility(video: HTMLVideoElement, next: ForcedVisibility, persist: boolean): void {
    const settings = this.byVideo.get(video)?.hostSettings ?? this.settingsByVideo.get(video);
    if (!settings) return;
    const source = resolveVideoSource(video);
    if (persist && source) this.persistForcedVisibility(source, settings, next);
    if (next === 'auto') {
      this.forced.clearOverride(video);
      this.dispose(video);
      this.attach(video, settings);
      return;
    }
    if (!source) return;
    this.forced.setOverride(video, source, next);
    this.attach(video, settings);
  }

  private persistForcedVisibility(source: ResolvedVideoSource, settings: IHostSettings, next: ForcedVisibility): void {
    const cacheKey = toVerdictCacheKey(source.url);
    if (!cacheKey) return;
    void requestVideoToggleUpdate(cacheKey, { sourceUrl: source.url, hostname: settings.hostname }, next);
  }

  private restoreForcedVisibility(handle: SessionHandle): void {
    if (!handle.cacheKey) return;
    void requestCachedVideoPredictions(handle.cacheKey).then(({ forcedVisibility }) => {
      if (this.byId.get(handle.sessionId) !== handle || handle.state.phase === 'disposed') return;
      if (forcedVisibility === 'auto' || this.userToggledCacheKeys.get(handle.video) === handle.cacheKey) return;
      log.debug('registry.forced_visibility.restored', { [ATTR.sessionId]: handle.sessionId, forcedVisibility });
      this.applyForcedVisibility(handle.video, forcedVisibility, false);
    });
  }

  private registerToggle(
    video: HTMLVideoElement,
    hostSettings: IHostSettings,
    forcedVisibility: ForcedVisibility,
    hasDetections: boolean,
    unprocessed = false,
  ): void {
    registerQuickToggle(video, {
      src: this.byVideo.get(video)?.src ?? resolveVideoSource(video)?.url ?? '',
      forcedVisibility,
      hasDetections,
      unprocessed,
      hostSettings,
      onToggle: next => this.setForcedVisibility(video, next),
    });
  }

  private awaitResolvedSource(video: HTMLVideoElement, hostSettings: IHostSettings): void {
    const pending = this.pendingByVideo.get(video);
    if (pending) {
      pending.hostSettings = hostSettings;
      return;
    }
    applyWholeBlur(video, hostSettings);
    const entry: PendingAttachment = { hostSettings, cancel: () => {} };
    const onLoadstart = () => {
      if (!resolveVideoSource(video)) return;
      entry.cancel();
      this.attach(video, entry.hostSettings);
    };
    entry.cancel = () => {
      video.removeEventListener('loadstart', onLoadstart);
      this.pendingByVideo.delete(video);
    };
    this.pendingByVideo.set(video, entry);
    video.addEventListener('loadstart', onLoadstart);
  }

  private sweepDisconnected(): void {
    for (const handle of this.byId.values()) {
      if (!handle.video.isConnected) this.dispatch(handle, { type: 'dispose' });
    }
    for (const [video, pending] of this.pendingByVideo) {
      if (!video.isConnected) pending.cancel();
    }
    this.forced.sweepDisconnected();
  }

  private bindDocumentVisibility(): void {
    if (this.documentVisibilityBound || !globalThis.document) return;
    this.documentVisibilityBound = true;
    document.addEventListener('visibilitychange', () => {
      for (const handle of this.byId.values()) this.applyVisibility(handle);
    });
  }

  private applyVisibility(handle: SessionHandle): void {
    if (handle.state.phase === 'disposed') return;
    const visible = !handle.suspended;
    handle.lookahead?.setVisible(visible && documentVisible());
    if (visible) handle.presenter.start();
    else handle.presenter.stop();
    if (handle.state.visible !== visible) this.dispatch(handle, { type: 'visibility', visible });
  }

  private openTap(handle: SessionHandle, source: ResolvedVideoSource): void {
    const tap = chooseTap(source);
    if (!tap) {
      this.tapResolved(handle, 'none', 'none');
      return;
    }
    const threshold = scoreThresholdOf(handle);
    handle.lookahead = openLookahead(
      {
        t: 'open',
        sessionId: handle.sessionId,
        tap,
        liveness: livenessOfDuration(handle.video.duration),
        scoreThreshold: threshold,
        suspicionThreshold: threshold * SUSPICION_RATIO,
        inputSize: currentInferenceCaptureSize(),
        cacheKey: handle.cacheKey,
        sourceUrl: handle.src,
        hostname: handle.hostSettings.hostname,
      },
      {
        reachable: kind => this.tapResolved(handle, kind, 'reachable'),
        unreachable: reason => {
          handle.lookahead = null;
          this.tapResolved(handle, 'none', reason);
        },
        sample: sample => this.onLookaheadSample(handle, sample),
        stat: stat => this.recordAnalysisStat(stat),
        infer: request => this.forwardLookaheadInference(handle, request),
      },
    );
    handle.lookahead.setVisible(!handle.suspended && documentVisible());
    this.sendPlayhead(handle);
  }

  private tapResolved(handle: SessionHandle, tap: TapKind, reason: UnreachableReason | 'reachable' | 'none'): void {
    if (handle.state.phase === 'disposed') return;
    const firstResolution = handle.tap === null;
    handle.tap = tap;
    handle.video.setAttribute(VIDEO_TAP_ATTR, tap);
    if (firstResolution) {
      recordCounter(METRIC.videoTapSessions, 1, { [ATTR.videoTap]: tap, [ATTR.videoTapReason]: reason });
    }
    log.info('video.tap.resolved', { [ATTR.sessionId]: handle.sessionId, [ATTR.videoTap]: tap, reason });
    this.dispatch(handle, { type: tap === 'none' ? 'tapUnreachable' : 'tapReachable' });
  }

  private recordAnalysisStat(stat: AnalysisStat): void {
    if (stat.kind === 'analysed' || stat.kind === 'cacheHit') {
      recordCounter(METRIC.lookaheadSamples, 1, {
        [ATTR.lookaheadSampleSource]: stat.kind === 'cacheHit' ? 'cache' : 'analysed',
      });
      return;
    }
    recordCounter(METRIC.lookaheadFailures, 1, {
      [ATTR.lookaheadFailureStage]: FAILURE_STAGE[stat.kind],
    });
  }

  private forwardLookaheadInference(
    handle: SessionHandle,
    request: LookaheadInferenceRequest,
  ): Promise<InferredSample | null> {
    if (handle.state.phase === 'disposed') {
      request.bitmap.close();
      return Promise.resolve(null);
    }
    const frameIndex = handle.nextFrameIndex++;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        handle.pendingLookahead.delete(frameIndex);
        resolve(null);
      }, LOOKAHEAD_INFERENCE_TIMEOUT_MS);
      handle.pendingLookahead.set(frameIndex, sample => {
        clearTimeout(timer);
        resolve(sample);
      });
      this.sendFrame(handle, {
        frameIndex,
        timestampSec: request.pointUs / 1e6,
        bitmap: request.bitmap,
        originalWidth: request.originalWidth,
        originalHeight: request.originalHeight,
        sampleKind: 'lookahead',
        priority: request.priority,
      }).catch(() => {
        handle.pendingLookahead.get(frameIndex)?.(null);
        handle.pendingLookahead.delete(frameIndex);
      });
    });
  }

  private sendFrame(
    handle: SessionHandle,
    frame: {
      frameIndex: number;
      timestampSec: number;
      bitmap: ImageBitmap;
      originalWidth: number;
      originalHeight: number;
      sampleKind: FrameSampleKind;
      priority: number;
    },
  ): Promise<void> {
    return requestVideoFrameInference({
      sample: {
        sessionId: handle.sessionId,
        frameIndex: frame.frameIndex,
        videoUrl: handle.cacheKey || handle.src,
        sourceUrl: handle.src,
        timestampSec: frame.timestampSec,
        bitmap: frame.bitmap,
        originalWidth: frame.originalWidth,
        originalHeight: frame.originalHeight,
        capturedAt: performance.now(),
      },
      sampleKind: frame.sampleKind,
      session: handle.trace,
      hostname: handle.hostSettings.hostname,
      priority: frame.priority,
    });
  }

  private queueThumbnail(handle: SessionHandle): void {
    const { video } = handle;
    const capture = () => void this.captureThumbnail(handle);
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA || video.poster) capture();
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
    video.addEventListener('loadeddata', capture, { once: true });
    const previous = handle.removeListeners;
    handle.removeListeners = () => {
      previous();
      video.removeEventListener('loadeddata', capture);
    };
  }

  private async captureThumbnail(handle: SessionHandle): Promise<void> {
    if (handle.state.phase !== 'active' || handle.state.verdictSeen) return;
    const captured = await captureThumbnailBitmap(handle.video);
    await this.sendCaptured(handle, captured, THUMBNAIL_FRAME_INDEX, 0, 'thumbnail');
  }

  private async sendLiveSample(handle: SessionHandle, timestampSec: number): Promise<void> {
    const frameIndex = handle.nextFrameIndex++;
    const captured = await captureFrameBitmap(handle.video, timestampSec);
    handle.pendingLive.set(frameIndex, { timestampSec, sentAt: performance.now() });
    const sent = await this.sendCaptured(handle, captured, frameIndex, timestampSec, 'live');
    if (sent) return;
    handle.pendingLive.delete(frameIndex);
    handle.live.settle();
  }

  private async sendCaptured(
    handle: SessionHandle,
    captured: CaptureResult,
    frameIndex: number,
    timestampSec: number,
    sampleKind: FrameSampleKind,
  ): Promise<boolean> {
    if (handle.state.phase === 'disposed') {
      captured.bitmap?.close();
      return false;
    }
    if (!captured.bitmap || captured.bitmap.width === 0 || captured.bitmap.height === 0) {
      captured.bitmap?.close();
      this.dispatch(handle, { type: 'liveCaptureFailed', permanent: captured.failure === 'permanent' });
      return false;
    }
    try {
      await this.sendFrame(handle, {
        frameIndex,
        timestampSec,
        bitmap: captured.bitmap,
        originalWidth: handle.video.videoWidth,
        originalHeight: handle.video.videoHeight,
        sampleKind,
        priority: sampleKind === 'thumbnail' ? INFERENCE_PRIORITY.videoThumbnail : INFERENCE_PRIORITY.liveFrame,
      });
      return true;
    } catch (error) {
      const permanent = error instanceof PermanentFrameTransferError;
      log.warn('video.capture.failed', {
        [ATTR.sessionId]: handle.sessionId,
        [ATTR.capturePermanent]: permanent,
        error,
      });
      this.dispatch(handle, { type: 'liveCaptureFailed', permanent });
      return false;
    }
  }

  private onPresentedFrame(handle: SessionHandle, mediaTimeSec: number): void {
    const now = performance.now();
    const { video } = handle;
    if (handle.lastFrameAt !== null && !video.paused && handle.state.tap !== 'pending') {
      const uncovered = handle.interpreter.verdictFor(mediaTimeSec, verdictOptionsOf(handle.state)).kind === 'none';
      if (uncovered) recordCounter(METRIC.videoUncoveredPlayingMs, now - handle.lastFrameAt);
    }
    handle.lastFrameAt = now;
    if (now - handle.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    handle.lastProgressAt = now;
    const coverageAheadSec = this.coverageAheadOf(handle, mediaTimeSec);
    if (!video.paused && Number.isFinite(coverageAheadSec)) {
      recordHistogram(METRIC.videoCoverageAheadSec, coverageAheadSec);
    }
    this.sendPlayhead(handle);
    this.dispatch(handle, { type: 'progress', coverageAheadSec });
  }

  private sendPlayhead(handle: SessionHandle): void {
    const { video } = handle;
    handle.lookahead?.setPlayhead({
      timeSec: video.currentTime,
      playbackRate: video.playbackRate,
      paused: video.paused,
    });
  }

  private coverageAheadOf(handle: SessionHandle, mediaTimeSec: number): number {
    const { video } = handle;
    return handle.interpreter.coverageAheadOf(mediaTimeSec, { durationSec: video.duration, loops: video.loop });
  }

  private isPlayheadCovered(handle: SessionHandle): boolean {
    const { video } = handle;
    return handle.interpreter.verdictFor(video.currentTime, verdictOptionsOf(handle.state)).kind !== 'none';
  }

  private dispatch(handle: SessionHandle, event: SessionEvent): void {
    const previous = handle.state;
    const { state, effects } = reduce(previous, event);
    handle.state = state;
    if (previous.phase !== state.phase || previous.tap !== state.tap || previous.liveMasking !== state.liveMasking) {
      log.info('video.session.transition', {
        [ATTR.sessionId]: handle.sessionId,
        [ATTR.hostname]: handle.hostSettings.hostname,
        [ATTR.sessionFrom]: previous.phase,
        [ATTR.sessionTo]: state.phase,
        [ATTR.sessionEvent]: event.type,
        tap: state.tap,
        liveMasking: state.liveMasking,
      });
    }
    this.execute(handle, effects);
  }

  private execute(handle: SessionHandle, effects: SessionEffect[]): void {
    const { video } = handle;
    for (const effect of effects) {
      switch (effect.kind) {
        case 'applyBlur':
          applyWholeBlur(video, handle.hostSettings);
          break;
        case 'clearBlur':
          clearWholeBlur(video);
          break;
        case 'startLiveMasking':
          handle.liveMaskingSince = performance.now();
          handle.live.start();
          break;
        case 'stopLiveMasking':
          if (handle.liveMaskingSince !== null) handle.liveMaskingMs += performance.now() - handle.liveMaskingSince;
          handle.liveMaskingSince = null;
          handle.live.stop();
          break;
        case 'requestLiveSample':
          handle.live.requestOnce();
          break;
        case 'reopenTap':
          this.reopenTap(handle);
          break;
        case 'commitSample': {
          const entry = handle.heldSamples.get(effect.sampleId);
          handle.heldSamples.delete(effect.sampleId);
          if (entry) handle.interpreter.record(entry);
          break;
        }
        case 'setStatus':
          if (effect.status === 'unsafe' && handle.cacheKey) this.unsafeCacheKeys.add(handle.cacheKey);
          clearProcessedStatus(video);
          video.setAttribute(PROCESSED_ATTR_MAP[STATUS_TO_PROCESSED[effect.status]], '');
          this.registerToggle(
            video,
            handle.hostSettings,
            'auto',
            effect.status === 'unsafe',
            effect.status === 'skipped',
          );
          break;
        case 'cleanup':
          this.teardown(handle);
          break;
      }
    }
  }

  private teardown(handle: SessionHandle): void {
    const { video } = handle;
    if (handle.liveMaskingSince !== null) handle.liveMaskingMs += performance.now() - handle.liveMaskingSince;
    recordHistogram(METRIC.videoLiveMaskingMs, handle.liveMaskingMs, { [ATTR.videoTap]: handle.tap ?? 'pending' });
    handle.live.stop();
    handle.lookahead?.close();
    handle.lookahead = null;
    handle.presenter.dispose();
    for (const resolve of handle.pendingLookahead.values()) resolve(null);
    handle.pendingLookahead.clear();
    if (handle.pendingLive.size > 0) void cancelVideoSessionInference(handle.sessionId);
    handle.pendingLive.clear();
    handle.heldSamples.clear();
    this.suspension.clearGrace(handle);
    handle.removeListeners();
    this.suspension.unobserve(video);
    clearWholeBlur(video);
    clearProcessedStatus(video);
    releaseCorsVideoCache(video);
    unregisterQuickToggle(video);
    video.removeAttribute(SESSION_SRC_ATTR);
    video.removeAttribute(SESSION_ID_ATTR);
    video.removeAttribute(VIDEO_TAP_ATTR);
    this.byId.delete(handle.sessionId);
    if (this.byVideo.get(video) === handle) this.byVideo.delete(video);
  }

  private bindMediaEvents(handle: SessionHandle): void {
    const { video } = handle;
    const onPlay = () => {
      this.sendPlayhead(handle);
      this.dispatch(handle, { type: 'play' });
    };
    const onPause = () => {
      this.sendPlayhead(handle);
      this.dispatch(handle, { type: 'pause', covered: this.isPlayheadCovered(handle) });
    };
    const loopRestarts = createLoopRestartDetector(loopingMediaOf(video));
    const onTimeUpdate = () => loopRestarts.observePlayback(video.currentTime, video.seeking);
    const onSeeked = () => {
      this.sendPlayhead(handle);
      if (loopRestarts.isLoopRestart(video.currentTime)) {
        this.dispatch(handle, { type: 'loopRestarted' });
        return;
      }
      this.dispatch(handle, {
        type: 'seeked',
        paused: video.paused,
        covered: this.isPlayheadCovered(handle),
        coverageAheadSec: this.coverageAheadOf(handle, video.currentTime),
      });
    };
    const onRateChange = () => this.sendPlayhead(handle);
    const onDurationChange = () => {
      if (this.restartIfDifferentMedia(handle)) return;
      handle.lookahead?.setLiveness(livenessOfDuration(video.duration));
    };
    const onSourceChanged = () => {
      loopRestarts.reset();
      if (resolveVideoSource(video)) this.attach(video, handle.hostSettings);
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('ratechange', onRateChange);
    video.addEventListener('durationchange', onDurationChange);
    video.addEventListener('loadstart', onSourceChanged);
    video.addEventListener('emptied', onSourceChanged);

    const previous = handle.removeListeners;
    handle.removeListeners = () => {
      previous();
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('ratechange', onRateChange);
      video.removeEventListener('durationchange', onDurationChange);
      video.removeEventListener('loadstart', onSourceChanged);
      video.removeEventListener('emptied', onSourceChanged);
    };
  }
}

export const videoSessions = new VideoSessionRegistry();
