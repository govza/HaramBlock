import { VideoDvrPlayer } from '@/entrypoints/content/presentation/videoDvrPlayer';
import { dvrCaptureScale } from '@/entrypoints/content/video/dvr/captureScale';
import { startDvrCaptureTap } from '@/entrypoints/content/video/dvr/captureTap';
import {
  deriveDvrDelayMs,
  isAnalysisUnderrun,
  MAX_DVR_DELAY_MS,
  UNDERRUN_VERDICT_STREAK,
} from '@/entrypoints/content/video/dvr/delay';
import { encodedBitrate } from '@/entrypoints/content/video/dvr/encodedFrameRing';
import {
  createDvrFrameStore,
  type CreateDvrFrameStoreOptions,
  type SessionFrameStore,
} from '@/entrypoints/content/video/dvr/frameStoreFactory';
import { dvrRingBudget, type RingQuality, type SessionDemand } from '@/entrypoints/content/video/dvr/ringBudget';
import { logger } from '@/utils/logger';

import type { DvrStoreKind } from '@/entrypoints/content/video/dvr/frameStore';
import type { VerdictTimeline } from '@/entrypoints/content/video/dvr/verdictTimeline';
import type { IMaskingSettings } from '@/utils/types';

const log = logger.withTag('dvrRun');

/** Ring horizon: the adaptive delay's ceiling plus slack, so a growing D still finds frames. */
const DVR_BUFFER_HORIZON_SEC = MAX_DVR_DELAY_MS / 1000 + 1;
/** Projection cap when neither display nor native size is known yet: assume 1080p rather than under-budget. */
const FALLBACK_CAPTURE_CAP_PX = 1920;
/** Re-register only on a material display resize (embedded → fullscreen), not layout jitter. */
const CAP_REREGISTER_RATIO = 1.25;
/** Per-verdict D growth when the store reports a decode stall (covered miss). */
const DECODE_STALL_DELAY_STEP_SEC = 0.25;
/** A tap can stall silently (muted cross-origin track); rVFC captures resume past this window. */
const TAP_LIVENESS_WINDOW_SEC = 0.5;

const TAP_LIVENESS_WALL_MS = 500;
/** Backwards steps smaller than this are currentTime quantization, not a seek. */
const TAP_KEY_JITTER_SEC = 0.02;
/** Forward nudge for a quantization-stalled key; must clear the ring's 1 ms jitter tolerance. */
const TAP_KEY_NUDGE_SEC = 0.002;

export type DvrRunEvent = { type: 'bufferReady'; at: number } | { type: 'analysisUnderrun'; at: number };

export interface VideoSurface {
  now(): number;
  currentTime(): number;
  nativeWidth(): number;
  nativeHeight(): number;
  displayWidth(): number;
  drawSource(): CanvasImageSource;
  markStoreKind(kind: DvrStoreKind | null): void;
}

export interface RingBudgetPort {
  quality(): RingQuality;
  sessionMaxBytes(): number;
  register(sessionId: string, demand: SessionDemand): void;
  release(sessionId: string): void;
}

export interface CaptureDriver {
  stop(): void;
}

export type CaptureDriverPort = (onFrame: (frame: VideoFrame, mediaTime: number) => void) => CaptureDriver | null;

export interface DvrPresenter {
  startDrain(): void;
  destroy(): void;
}

export interface PresenterPort {
  create(options: {
    store: SessionFrameStore;
    timeline: VerdictTimeline;
    getDelaySec: () => number;
    onReady: () => void;
  }): DvrPresenter;
}

export interface DvrRunPorts {
  events: (event: DvrRunEvent) => void;
  onDelayChanged: (delaySec: number) => void;
  surface: VideoSurface;
  budget: RingBudgetPort;
  createStore: (options: CreateDvrFrameStoreOptions) => SessionFrameStore;
  captureDriver: CaptureDriverPort;
  presenter: PresenterPort;
}

export interface DvrRunContext {
  readonly sessionId: string;
  readonly timeline: VerdictTimeline;
  readonly latenciesMs: readonly number[];
  readonly stallFloorSec: number;
  readonly encodedIneligible: boolean;
}

export interface DvrRunCarry {
  stallFloorSec: number;
  encodedIneligible: boolean;
}

export interface DvrRun {
  readonly delaySec: number;
  onVerdict(): void;
  onTick(mediaTime: number): void;
  drain(): void;
  stop(): DvrRunCarry;
}

export function defaultDvrRunPorts(options: {
  video: HTMLVideoElement;
  getMasking: () => IMaskingSettings;
  events: (event: DvrRunEvent) => void;
  onDelayChanged: (delaySec: number) => void;
}): DvrRunPorts {
  const { video, getMasking, events, onDelayChanged } = options;
  return {
    events,
    onDelayChanged,
    surface: {
      now: () => performance.now(),
      currentTime: () => video.currentTime,
      nativeWidth: () => video.videoWidth,
      nativeHeight: () => video.videoHeight,
      displayWidth: () => Math.round(video.clientWidth * (globalThis.devicePixelRatio || 1)),
      drawSource: () => video,
      markStoreKind: kind => {
        if (kind === null) delete video.dataset.hbDvrStore;
        else video.dataset.hbDvrStore = kind;
      },
    },
    budget: dvrRingBudget,
    createStore: createDvrFrameStore,
    captureDriver: onFrame => startDvrCaptureTap(video, onFrame),
    presenter: {
      create: ({ store, timeline, getDelaySec, onReady }) =>
        new VideoDvrPlayer({ video, store, timeline, getDelaySec, getMasking, onReady }),
    },
  };
}

export function startDvrRun(ports: DvrRunPorts, ctx: DvrRunContext): DvrRun {
  return new Run(ports, ctx);
}

class Run implements DvrRun {
  private delay: number;
  private stallFloorSec: number;
  private encodedIneligible: boolean;
  private stopped = false;

  private readonly store: SessionFrameStore;
  private readonly presenter: DvrPresenter;
  private readonly driver: CaptureDriver | null;

  private lastCapturedMediaTime = Number.NEGATIVE_INFINITY;
  private lastTapMediaTime = Number.NEGATIVE_INFINITY;
  private lastTapWallMs = Number.NEGATIVE_INFINITY;
  private captureSurface: OffscreenCanvas | null = null;
  private registeredWidth: number;
  private registeredHeight: number;
  private registeredCaptureCap: number;
  private lastCoveredMisses = 0;
  private stallHoldoff = true;
  private underrunStreak = 0;
  private demandEncoded = false;

  constructor(
    private readonly ports: DvrRunPorts,
    private readonly ctx: DvrRunContext,
  ) {
    const { surface, budget } = ports;
    this.delay = Math.max(
      deriveDvrDelayMs(ctx.latenciesMs, ctx.timeline.coverageAheadOf(surface.currentTime())) / 1000,
      ctx.stallFloorSec,
    );
    this.stallFloorSec = ctx.stallFloorSec;
    this.encodedIneligible = ctx.encodedIneligible;

    this.registeredWidth = surface.nativeWidth();
    this.registeredHeight = surface.nativeHeight();
    this.registeredCaptureCap = this.captureWidthCap();
    this.registerDemand();

    const quality = budget.quality();
    const store = ports.createStore({
      maxDurationSec: this.ringHorizonSec(quality),
      maxBytes: budget.sessionMaxBytes(),
      probeWidth: this.registeredWidth || FALLBACK_CAPTURE_CAP_PX,
      probeHeight: this.registeredHeight || Math.round((FALLBACK_CAPTURE_CAP_PX * 9) / 16),
      encodedIneligible: this.encodedIneligible,
      onEncodedError: () => {
        this.encodedIneligible = true;
      },
      onKindChange: kind => {
        if (this.stopped) return;
        this.demandEncoded = kind === 'encoded';
        surface.markStoreKind(kind);
        this.registerDemand();
      },
    });
    this.store = store;
    this.demandEncoded = store.kind() === 'encoded';
    surface.markStoreKind(store.kind());

    this.presenter = ports.presenter.create({
      store,
      timeline: ctx.timeline,
      getDelaySec: () => this.delay,
      onReady: () => ports.events({ type: 'bufferReady', at: surface.now() }),
    });

    this.driver = ports.captureDriver((frame, mediaTime) => {
      // The push driver can outlive its run by a frame or two (async reader).
      if (this.stopped) {
        frame.close();
        return;
      }
      // currentTime quantizes coarser than a 60 fps frame grid: an equal key is
      // nudged forward, a genuinely backwards key is a seek.
      const sinceLastSec = mediaTime - this.lastCapturedMediaTime;
      const key =
        sinceLastSec <= 0 && sinceLastSec > -TAP_KEY_JITTER_SEC
          ? this.lastCapturedMediaTime + TAP_KEY_NUDGE_SEC
          : mediaTime;
      this.lastTapMediaTime = mediaTime;
      this.lastTapWallMs = this.ports.surface.now();
      this.capture(frame, key);
    });
  }

  get delaySec(): number {
    return this.delay;
  }

  onTick(mediaTime: number): void {
    if (this.stopped) return;
    // Both clocks: media distance survives seeks, wall-clock catches a tap that
    // died while the media clock crawls (slow rate, a stall).
    const tapLive =
      Math.abs(mediaTime - this.lastTapMediaTime) < TAP_LIVENESS_WINDOW_SEC &&
      this.ports.surface.now() - this.lastTapWallMs < TAP_LIVENESS_WALL_MS;
    if (this.driver && tapLive) return;
    this.capture(null, mediaTime);
  }

  drain(): void {
    if (this.stopped) return;
    this.presenter.startDrain();
  }

  stop(): DvrRunCarry {
    if (!this.stopped) {
      this.stopped = true;
      this.driver?.stop();
      this.ports.budget.release(this.ctx.sessionId);
      this.presenter.destroy();
      this.store.release();
      this.ports.surface.markStoreKind(null);
    }
    return { stallFloorSec: this.stallFloorSec, encodedIneligible: this.encodedIneligible };
  }

  /**
   * D is latched per run so presentation never jumps mid-run — but a run that
   * latched too small a D (no observed round-trips yet at the first play, or a
   * covered range whose coverage ran out) would present verdict-less frames,
   * and therefore whole-blur, for the rest of the run. Let D grow, and only
   * grow: presentation slides further behind the live edge — repeating a
   * moment of already-seen video, within the ring's horizon — instead of
   * jumping forward into content no verdict describes.
   */
  onVerdict(): void {
    if (this.stopped) return;
    const coverageAheadSec = this.ctx.timeline.coverageAheadOf(this.ports.surface.currentTime());
    const derivedSec = deriveDvrDelayMs(this.ctx.latenciesMs, coverageAheadSec) / 1000;
    // A decode stall (covered miss since the last sync) feeds the same
    // let-D-grow path: the slow decoder buys itself headroom by sliding
    // further behind the live edge. A raise itself moves the target backward,
    // forcing a decoder re-warm whose misses would read as a fresh stall and
    // ratchet D to the ceiling — so the sync after any raise swallows its miss
    // delta; a genuine sustained stall re-raises on the sync after that.
    const misses = this.store.coveredMisses();
    const missDelta = misses > this.lastCoveredMisses;
    const stalled = missDelta && !this.stallHoldoff;
    this.lastCoveredMisses = misses;
    if (missDelta) this.stallHoldoff = false;
    // Raise by the measured capture→presentable lag when it beats the fixed
    // step: a pipeline running ~a second behind escapes in one raise.
    const newestSec = this.store.newestTime();
    const pipelineLagSec = newestSec === null ? 0 : this.ports.surface.currentTime() - newestSec;
    const stallTargetSec = stalled
      ? Math.min(
          MAX_DVR_DELAY_MS / 1000,
          Math.max(this.delay + DECODE_STALL_DELAY_STEP_SEC, pipelineLagSec + DECODE_STALL_DELAY_STEP_SEC),
        )
      : 0;
    const targetSec = Math.max(derivedSec, stallTargetSec);
    if (targetSec > this.delay) {
      this.delay = targetSec;
      // Only stall-driven growth persists into the carry: latency-derived
      // growth re-derives correctly at the next run.
      if (stallTargetSec >= targetSec) {
        this.stallFloorSec = Math.max(this.stallFloorSec, stallTargetSec);
      }
      this.stallHoldoff = true;
      this.registerDemand();
      this.ports.onDelayChanged(targetSec);
    }
    this.detectUnderrun(coverageAheadSec);
  }

  /** Sustained "D pinned at ceiling, coverage trailing" becomes a machine event; the machine decides the response. */
  private detectUnderrun(coverageAheadSec: number): void {
    if (!isAnalysisUnderrun(this.ctx.latenciesMs, coverageAheadSec, this.delay)) {
      this.underrunStreak = 0;
      return;
    }
    this.underrunStreak++;
    if (this.underrunStreak < UNDERRUN_VERDICT_STREAK) return;
    // Reset so the post-relief window measures fresh verdicts before a second fire.
    this.underrunStreak = 0;
    this.ports.events({ type: 'analysisUnderrun', at: this.ports.surface.now() });
  }

  /**
   * Finite capture-width cap: rendered width in device pixels, up to native.
   * The budget ladder's full tier has no ceiling of its own, so this is the
   * number that bounds both the capture and its projection in the shared budget.
   */
  private captureWidthCap(): number {
    const displayWidth = this.ports.surface.displayWidth();
    const nativeWidth = this.registeredWidth;
    if (displayWidth > 0 && nativeWidth > 0) return Math.min(displayWidth, nativeWidth);
    return displayWidth || nativeWidth || FALLBACK_CAPTURE_CAP_PX;
  }

  private registerDemand(): void {
    // An encoded session's demand is bitrate-shaped, not RGBA-shaped: it
    // barely registers on the ladder, so it never degrades raw sessions.
    const bitrateWidth = this.registeredWidth || FALLBACK_CAPTURE_CAP_PX;
    const bitrateHeight = this.registeredHeight || Math.round((FALLBACK_CAPTURE_CAP_PX * 9) / 16);
    this.ports.budget.register(this.ctx.sessionId, {
      nativeWidth: this.registeredWidth,
      nativeHeight: this.registeredHeight,
      captureMaxWidth: this.captureWidthCap(),
      horizonSec: DVR_BUFFER_HORIZON_SEC,
      minHorizonSec: this.delay + 1,
      ...(this.demandEncoded ? { encodedBytesPerSec: encodedBitrate(bitrateWidth, bitrateHeight) / 8 } : {}),
    });
  }

  /** Never shrink a live ring below the latched D: presentation would strand on the warm-up frame. */
  private ringHorizonSec(quality: RingQuality): number {
    return Math.max(this.delay + 1, DVR_BUFFER_HORIZON_SEC * quality.horizonScale);
  }

  /**
   * Feed the ring: presentation-sized for the raw ring (throttled to its
   * cadence), native-resolution VideoFrames for the encoded ring (native rate
   * from the push driver). Buffering is display-only (no pixel readback), so it
   * works even for sources whose pixels inference may not read — the taint just
   * travels with the bitmap onto the presentation canvas.
   */
  private capture(tapFrame: VideoFrame | null, mediaTime: number): void {
    if (this.stopped) {
      tapFrame?.close();
      return;
    }
    const { surface, budget } = this.ports;
    // Read the shared budget's current tier every capture: degradation and
    // recovery apply to live rings without a restart.
    const quality = budget.quality();
    const intervalSec =
      this.store.captureMode === 'video-frame' ? quality.encodedCaptureIntervalSec : quality.captureIntervalSec;
    // Chrome can report the same currentTime for consecutive tap frames, which
    // the native-rate interval (0) would otherwise let through.
    if (
      mediaTime === this.lastCapturedMediaTime ||
      (mediaTime - this.lastCapturedMediaTime < intervalSec && mediaTime > this.lastCapturedMediaTime)
    ) {
      tapFrame?.close();
      return;
    }
    try {
      this.store.setLimits(this.ringHorizonSec(quality), budget.sessionMaxBytes());
      const nativeWidth = surface.nativeWidth();
      const nativeHeight = surface.nativeHeight();
      if (!nativeWidth || !nativeHeight) return;
      if (nativeWidth !== this.registeredWidth || nativeHeight !== this.registeredHeight) {
        // The DVR can start off the 'play' event, which fires before metadata:
        // the budget then holds a fallback 16:9 projection that understates a
        // portrait session by ~3x. Correct it as soon as the real geometry lands.
        this.registeredWidth = nativeWidth;
        this.registeredHeight = nativeHeight;
        this.registeredCaptureCap = this.captureWidthCap();
        this.registerDemand();
      } else {
        const widthCap = this.captureWidthCap();
        if (capChangedMaterially(widthCap, this.registeredCaptureCap)) {
          // The display cap is demand too (the full tier has no ladder
          // ceiling): a materially resized player — embedded → fullscreen —
          // re-registers; small layout jitter stays below the hysteresis.
          this.registeredCaptureCap = widthCap;
          this.registerDemand();
        }
      }
      if (this.store.captureMode === 'video-frame') {
        // Encoded store: zero-copy GPU reference at native resolution — the
        // capture-scale ladder is bypassed, hardware encoding replaces it. The
        // timestamp carries the media time through encode → store → decode. A
        // tap frame is re-wrapped: its own timestamp lives in the capture
        // clock, not the media timeline.
        try {
          const frame = new VideoFrame(tapFrame ?? surface.drawSource(), {
            timestamp: Math.round(mediaTime * 1_000_000),
          });
          this.lastCapturedMediaTime = mediaTime;
          this.store.push(frame, mediaTime);
        } catch (error) {
          // Typically SecurityError on a tainted source: VideoFrame needs
          // readable pixels, which the display-only canvas path does not.
          log.debug('VideoFrame capture failed; demoting to raw ring:', error);
          this.encodedIneligible = true;
          this.store.demoteToRaw();
        }
        return;
      }
      // Downscale through a canvas, NOT createImageBitmap's resize options:
      // Firefox never implemented those, and per WebIDL silently ignores them —
      // native-resolution HD frames then blow the ring's byte budget, its span
      // never reaches the presentation delay, and the DVR warms forever.
      const scale = dvrCaptureScale({
        nativeWidth,
        nativeHeight,
        displayWidth: surface.displayWidth(),
        maxWidth: quality.maxWidth,
        delaySec: this.delay,
        captureIntervalSec: quality.captureIntervalSec,
        maxBytes: budget.sessionMaxBytes(),
      });
      const width = Math.max(1, Math.round(nativeWidth * scale));
      const height = Math.max(1, Math.round(nativeHeight * scale));
      let canvas = this.captureSurface;
      if (!canvas || canvas.width !== width || canvas.height !== height) {
        canvas = new OffscreenCanvas(width, height);
        this.captureSurface = canvas;
      }
      const canvasCtx = canvas.getContext('2d');
      if (!canvasCtx) return;
      canvasCtx.drawImage(tapFrame ?? surface.drawSource(), 0, 0, width, height);
      // transferToImageBitmap needs no readback, so this works (display-only,
      // taint carried along) even for sources whose pixels we may not read.
      const bitmap = canvas.transferToImageBitmap();
      this.lastCapturedMediaTime = mediaTime;
      this.store.push(bitmap, mediaTime);
    } catch (error) {
      log.debug('DVR buffer capture failed:', error);
    } finally {
      tapFrame?.close();
    }
  }
}

function capChangedMaterially(nextCap: number, registeredCap: number): boolean {
  const [smaller, larger] = nextCap < registeredCap ? [nextCap, registeredCap] : [registeredCap, nextCap];
  return smaller <= 0 || larger / smaller >= CAP_REREGISTER_RATIO;
}
