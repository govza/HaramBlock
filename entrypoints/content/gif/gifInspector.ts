import { gifInferenceFrameCap, sampleFrameIndices, type DecodedGifFrame } from '@/entrypoints/content/gif/gifDecoder';
import { aggregateGifVerdict } from '@/entrypoints/content/gif/gifVerdict';
import { GIF_MIN_MASK_INERTIA } from '@/utils/constants/gif';
import { generateNonce } from '@/utils/nonce';
import { ATTR, getLogger } from '@/utils/telemetry';
import {
  cancelRoundtrip,
  endRoundtrip,
  endRoundtripChild,
  getRoundtripContext,
  SPAN,
  startRoundtrip,
  startRoundtripChild,
} from '@/utils/telemetry/roundtrip';
import {
  shouldBlock,
  type GifFrameInferenceResult,
  type IGifFramePrediction,
  type IImagePrediction,
} from '@/utils/types';

import type { PredictionCache } from '@/entrypoints/content/core/predictionCache';
import type { GifTransport } from '@/entrypoints/content/gif/gifTransport';

const log = getLogger('gifInspector');

export const MAX_GIF_SESSIONS = 500;
export const GIF_VERDICT_TIMEOUT_MS = 20_000;

/**
 * What the canvas player needs to replay a blocked GIF with per-frame masks. Only exists while the
 * decoded frames are still held (they are released once a GIF is judged safe or its session retires).
 */
export interface GifPlayback {
  frames: DecodedGifFrame[];
  framePredictions: Map<number, IGifFramePrediction>;
  maskInertia: number;
}

/**
 * The image pipeline the inspector reports into. It finds and protects the `<img>` copies of a GIF,
 * presents a verdict on one copy, finalizes copies as skipped, and hands an un-animated GIF back to
 * the single-frame path. The inspector owns the GIF sessions and their timers; the host owns the DOM.
 */
export interface GifInspectorDeps {
  hostSettings: { readonly hostname: string };
  cache: PredictionCache;
  transport: GifTransport;
  findImages(src: string): HTMLImageElement[];
  priorityFor(img: HTMLImageElement): number;
  isBelowMinSize(src: string, img: HTMLImageElement): boolean;
  protect(img: HTMLImageElement): void;
  present(img: HTMLImageElement, verdict: IImagePrediction): void;
  skip(src: string): void;
  fallback(img: HTMLImageElement, src: string): void;
}

/**
 * Multi-frame inspection of animated GIFs, keyed by src. Every frame is decoded for playback, a
 * sampled subset is sent for inference, and the frame verdicts fold into one verdict once every
 * sampled frame has returned or failed. Failures and the verdict timeout always resolve to a blocked
 * verdict; a GIF is never revealed because inspection broke down.
 */
export interface GifInspector {
  inspect(img: HTMLImageElement, src: string): void;
  handleFrameResults(results: GifFrameInferenceResult[]): void;
  replaceVerdict(src: string, verdict: IImagePrediction): boolean;
  playbackFor(src: string): GifPlayback | undefined;
  dispose(): void;
}

/**
 * Aggregation state for one animated GIF. `frameCount` is the number of sampled frames whose
 * verdicts are expected; it stays 0 until decoding completes, so nothing finalizes before then.
 */
interface GifSession {
  sessionId: string;
  frameCount: number;
  received: number;
  failedFrames: number;
  frames?: DecodedGifFrame[];
  framePredictions: Map<number, IGifFramePrediction>;
  maskInertia: number;
  verdict?: IImagePrediction;
  finalized: boolean;
  disposed: boolean;
  timeoutId?: ReturnType<typeof setTimeout>;
}

const releaseFrames = (frames: DecodedGifFrame[] | undefined): void => {
  frames?.forEach(frame => frame.bitmap.close());
};

const stopVerdictTimeout = (session: GifSession): void => {
  if (session.timeoutId) clearTimeout(session.timeoutId);
  session.timeoutId = undefined;
};

const allFramesAccountedFor = (session: GifSession): boolean =>
  session.frameCount > 0 && session.received + session.failedFrames >= session.frameCount;

/**
 * Masks persist across the gap between sampled frames so un-inspected frames stay covered; the floor
 * absorbs single-frame detection jitter.
 */
const maskInertiaFor = (totalFrames: number, sampledFrames: number): number =>
  Math.max(GIF_MIN_MASK_INERTIA, Math.ceil(totalFrames / Math.max(1, sampledFrames)));

export const createGifInspector = (deps: GifInspectorDeps): GifInspector => {
  const sessions = new Map<string, GifSession>();

  const presentToAll = (src: string, verdict: IImagePrediction): void => {
    for (const img of deps.findImages(src)) deps.present(img, verdict);
  };

  /**
   * Safe GIFs play natively, so their decoded bitmaps are dead weight once presented; a later
   * force-block toggle uses a whole-frame blur that needs no frames.
   */
  const finalize = (src: string, forceBlocked: boolean): void => {
    const session = sessions.get(src);
    if (!session || session.finalized || session.disposed) return;

    session.finalized = true;
    stopVerdictTimeout(session);

    const firstBitmap = session.frames?.[0]?.bitmap;
    const verdict = aggregateGifVerdict({
      src,
      hostname: deps.hostSettings.hostname,
      framePredictions: session.framePredictions.values(),
      fallbackSize: firstBitmap && { width: firstBitmap.width, height: firstBitmap.height },
      forceBlocked,
      now: Date.now(),
    });
    session.verdict = verdict;
    deps.cache.set(src, verdict);

    startRoundtripChild(src, SPAN.apply);
    presentToAll(src, verdict);
    endRoundtripChild(src, SPAN.apply);

    const blocked = shouldBlock(verdict);
    if (!blocked) {
      releaseFrames(session.frames);
      session.frames = undefined;
    }

    endRoundtrip(src, {
      status: 'success',
      attributes: {
        [ATTR.detectionsCount]: verdict.predictions.length,
        [ATTR.overlayType]: blocked ? 'segment' : undefined,
        forceBlocked,
        failedFrames: session.failedFrames,
      },
    });
  };

  const finalizeIfComplete = (src: string, session: GifSession): void => {
    if (allFramesAccountedFor(session)) finalize(src, session.failedFrames > 0);
  };

  const recordFailedFrame = (src: string, session: GifSession): void => {
    if (session.finalized || session.disposed) return;
    session.failedFrames += 1;
    finalizeIfComplete(src, session);
  };

  const recordFramePrediction = (prediction: IGifFramePrediction): void => {
    const session = sessions.get(prediction.src);
    if (!session || session.sessionId !== prediction.sessionId || session.finalized) return;
    if (!session.framePredictions.has(prediction.frameIndex)) session.received += 1;
    session.framePredictions.set(prediction.frameIndex, prediction);
    finalizeIfComplete(prediction.src, session);
  };

  /**
   * A blocked GIF is still on screen through the canvas player, so it degrades to a frame-free
   * whole-frame blur before its frames close: the GIF stays hidden while the player stops drawing.
   */
  const retire = (src: string, session: GifSession): void => {
    const { frames } = session;
    if (session.verdict && shouldBlock(session.verdict)) {
      session.frames = undefined;
      presentToAll(src, session.verdict);
    }
    stopVerdictTimeout(session);
    releaseFrames(frames);
    sessions.delete(src);
    cancelRoundtrip(src, 'evicted');
  };

  /**
   * Reclaims oldest-first but skips unfinalized sessions: their frames are mid decode/inference, and
   * closing them out from under their owner breaks playback.
   */
  const evictIfNeeded = (): void => {
    let overflow = sessions.size - MAX_GIF_SESSIONS;
    if (overflow <= 0) return;
    for (const [src, session] of sessions) {
      if (overflow <= 0) break;
      if (!session.finalized) continue;
      retire(src, session);
      overflow--;
    }
  };

  const fallbackToSingleFrame = (img: HTMLImageElement, src: string, session: GifSession): void => {
    stopVerdictTimeout(session);
    releaseFrames(session.frames);
    sessions.delete(src);
    if (session.disposed) {
      cancelRoundtrip(src, 'disposed');
      return;
    }
    deps.fallback(img, src);
  };

  const decodeGif = async (src: string) => {
    startRoundtripChild(src, SPAN.capture);
    try {
      return await deps.transport.decode(src);
    } catch (error) {
      log.debug('gif.decode.failed', { [ATTR.src]: src, fallback: 'single frame', error }, getRoundtripContext(src));
      return null;
    }
  };

  const decodeAndSend = async (img: HTMLImageElement, src: string, session: GifSession): Promise<void> => {
    if (!(await deps.transport.channelReady())) {
      fallbackToSingleFrame(img, src, session);
      return;
    }

    if (deps.isBelowMinSize(src, img)) {
      sessions.delete(src);
      endRoundtrip(src, { status: 'skipped', attributes: { reason: 'below min size' } });
      deps.skip(src);
      return;
    }

    const decoded = await decodeGif(src);
    endRoundtripChild(src, SPAN.capture, { frameCount: decoded?.frames.length ?? 0 });

    if (session.disposed) {
      releaseFrames(decoded?.frames);
      cancelRoundtrip(src, 'disposed');
      return;
    }

    if (!decoded) {
      fallbackToSingleFrame(img, src, session);
      return;
    }

    session.frames = decoded.frames;
    const totalFrames = decoded.frames.length;
    const inferenceIndices = sampleFrameIndices(totalFrames, gifInferenceFrameCap(totalFrames));
    session.frameCount = inferenceIndices.length;
    session.maskInertia = maskInertiaFor(totalFrames, inferenceIndices.length);
    const roundtripContext = getRoundtripContext(src);
    const priority = deps.priorityFor(img);

    session.timeoutId = setTimeout(() => finalize(src, true), GIF_VERDICT_TIMEOUT_MS);

    await Promise.all(
      inferenceIndices.map(async index => {
        const frame = decoded.frames[index];
        if (!frame) return;
        try {
          await deps.transport.sendFrame({
            src,
            bitmap: frame.bitmap,
            hostname: deps.hostSettings.hostname,
            sessionId: session.sessionId,
            frameIndex: frame.frameIndex,
            frameCount: session.frameCount,
            originalWidth: decoded.width,
            originalHeight: decoded.height,
            priority,
            parent: roundtripContext,
          });
        } catch (error) {
          log.debug(
            'gif.frame.send.failed',
            { [ATTR.src]: src, [ATTR.frameIndex]: frame.frameIndex, error },
            roundtripContext,
          );
          recordFailedFrame(src, session);
        }
      }),
    );
  };

  const startSession = (img: HTMLImageElement, src: string): void => {
    const session: GifSession = {
      sessionId: generateNonce(),
      frameCount: 0,
      received: 0,
      failedFrames: 0,
      framePredictions: new Map(),
      maskInertia: GIF_MIN_MASK_INERTIA,
      finalized: false,
      disposed: false,
    };
    sessions.set(src, session);
    evictIfNeeded();

    startRoundtrip(src, {
      src,
      hostname: deps.hostSettings.hostname,
      mediaKind: 'gif',
      attributes: { [ATTR.sessionId]: session.sessionId },
    });
    deps.protect(img);

    void decodeAndSend(img, src, session);
  };

  return {
    inspect: (img, src) => {
      const existing = sessions.get(src);
      if (!existing) {
        startSession(img, src);
        return;
      }
      if (existing.finalized && existing.verdict) deps.present(img, existing.verdict);
      else deps.protect(img);
    },

    handleFrameResults: results => {
      for (const result of results) {
        if (result.status === 'ok') {
          recordFramePrediction(result.prediction);
          continue;
        }
        const session = sessions.get(result.src);
        if (session?.sessionId === result.sessionId) recordFailedFrame(result.src, session);
      }
    },

    replaceVerdict: (src, verdict) => {
      const session = sessions.get(src);
      if (!session?.finalized || !session.verdict) return false;
      session.verdict = verdict;
      return true;
    },

    playbackFor: src => {
      const session = sessions.get(src);
      if (!session?.frames?.length) return undefined;
      const { frames, framePredictions, maskInertia } = session;
      return { frames, framePredictions, maskInertia };
    },

    dispose: () => {
      for (const session of sessions.values()) {
        session.disposed = true;
        if (session.timeoutId) clearTimeout(session.timeoutId);
        releaseFrames(session.frames);
      }
      sessions.clear();
    },
  };
};
