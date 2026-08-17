import { logger } from '@/utils/logger';
import { backgroundRpc } from '@/utils/messaging/content';
import { onModelSettingsChange } from '@/utils/modelSettings';

// Cache CORS videos per original video element to avoid re-creating on every frame
// Stores either the cached CORS video or null if CORS failed (to avoid retrying).
// blobUrl is set when the clone plays Relay-Fetched bytes and must be revoked on release.
type CorsVideoEntry =
  { corsVideo: HTMLVideoElement; src: string; blobUrl?: string } | { corsVideo: null; src: string; blobUrl?: never };
const corsVideoCache = new WeakMap<HTMLVideoElement, CorsVideoEntry>();
/** Concurrent callers (sampler + mask overlay) share one clone/download per video. */
const inflightClones = new WeakMap<HTMLVideoElement, Promise<HTMLVideoElement>>();

const POSTER_LOAD_TIMEOUT_MS = 2_500;
const CORS_VIDEO_LOAD_TIMEOUT_MS = 4_000;
const CORS_VIDEO_SEEK_TIMEOUT_MS = 2_000;
const BITMAP_CREATE_TIMEOUT_MS = 2_500;
const VIDEO_TIME_TOLERANCE_SEC = 0.05;

export class CaptureStageTimeoutError extends Error {
  constructor(stage: string, timeoutMs: number) {
    super(`${stage} timed out after ${timeoutMs}ms`);
    this.name = 'CaptureStageTimeoutError';
  }
}

function withStageTimeout<T>(
  promise: Promise<T>,
  stage: string,
  timeoutMs: number,
  onLate?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new CaptureStageTimeoutError(stage, timeoutMs));
    }, timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        if (timedOut) onLate?.(value);
        else resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        if (!timedOut) reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * A permanent failure (canvas taint) can never succeed for this source, so the
 * session finalizes as allow; a transient one (no frame data yet) may succeed
 * on a later attempt, so the session stays fail-closed while retrying.
 */
export type CaptureResult =
  { bitmap: ImageBitmap; failure?: never } | { bitmap?: never; failure: 'permanent' | 'transient' };

export async function captureThumbnailBitmap(video: HTMLVideoElement): Promise<CaptureResult> {
  if (video.poster) {
    try {
      const posterBitmap = await extractPosterImage(video.poster);
      if (posterBitmap) {
        return { bitmap: posterBitmap };
      }
    } catch (error) {
      logger.withTag('frameCapture').debug('Failed to extract poster image, falling back to video frame:', error);
    }
  }

  // Fail closed: below HAVE_CURRENT_DATA drawImage silently draws nothing, and a
  // transparent capture would be verdicted "safe" for content nobody analyzed.
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    logger.withTag('frameCapture').debug('No current frame data, cannot extract thumbnail');
    return { failure: 'transient' };
  }

  return drawToBitmap(video);
}

export async function captureFrameBitmap(video: HTMLVideoElement, timestampSec: number): Promise<CaptureResult> {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    logger.withTag('frameCapture').debug('Skipping frame capture, no current frame data');
    return { failure: 'transient' };
  }

  return drawToBitmap(video, timestampSec);
}

/**
 * Preprocessing letterboxes the sampled frame to the active model's input size,
 * so pixels beyond it only inflate the capture→transfer→preprocess round-trip
 * (which sizes the DVR presentation delay). Cap the frame's longest side at that
 * size — the letterbox scale binds on the longest side. Until the model is
 * known, fall back to the largest available input size; masks come back
 * relative to the sent dimensions, so overlay geometry is unaffected.
 */
const FALLBACK_CAPTURE_SIZE = 640;
let inferenceCaptureSize = FALLBACK_CAPTURE_SIZE;
let captureSizeTracked = false;

async function refreshInferenceCaptureSize(): Promise<void> {
  try {
    const [models, modelId] = await Promise.all([
      backgroundRpc.getAvailableModels(),
      backgroundRpc.getEffectiveModelId(),
    ]);
    const size = models.find(model => model.id === modelId)?.inputSize;
    if (size) inferenceCaptureSize = size;
  } catch (error) {
    logger.withTag('frameCapture').debug('Could not resolve model input size, keeping', inferenceCaptureSize, error);
  }
}

/** Follow the active model: resolve its input size now and on every model switch. */
function trackInferenceCaptureSize(): void {
  if (captureSizeTracked) return;
  captureSizeTracked = true;
  void refreshInferenceCaptureSize();
  onModelSettingsChange(() => void refreshInferenceCaptureSize());
}

async function drawToBitmap(video: HTMLVideoElement, timestampSec?: number): Promise<CaptureResult> {
  trackInferenceCaptureSize();
  const { canvas, ctx, width, height } = createDrawingSurface(video, inferenceCaptureSize);
  if (!ctx || width === 0 || height === 0) {
    logger.withTag('frameCapture').warn('Video has zero dimensions, cannot capture frame');
    return { failure: 'transient' };
  }

  const sourceVideo = await ensureCorsSafeSource(video, timestampSec);
  ctx.drawImage(sourceVideo, 0, 0, width, height);

  // Chrome only rejects a tainted-canvas bitmap later at the transfer port
  // (DataCloneError → timeout); a 1-pixel readback surfaces the taint here.
  try {
    ctx.getImageData(0, 0, 1, 1);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'SecurityError') {
      logger.withTag('frameCapture').warn('Canvas tainted by cross-origin video, cannot capture');
      return { failure: 'permanent' };
    }
    throw error;
  }

  try {
    return {
      bitmap: await withStageTimeout(
        createImageBitmap(canvas),
        'Frame Sample bitmap creation',
        BITMAP_CREATE_TIMEOUT_MS,
        late => late.close(),
      ),
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'SecurityError') {
      logger.withTag('frameCapture').warn('Cannot create bitmap from cross-origin video canvas');
      return { failure: 'permanent' };
    }
    throw error;
  }
}

export async function ensureCorsSafeSource(
  video: HTMLVideoElement,
  timestampSec = video.currentTime,
): Promise<HTMLVideoElement> {
  const actualSrc = video.currentSrc || video.src;

  if (video.srcObject || video.crossOrigin || actualSrc.startsWith('blob:') || !actualSrc) {
    return video;
  }

  // Check cache first
  const cached = corsVideoCache.get(video);
  if (cached) {
    // Invalidate cache if source changed
    if (cached.src !== actualSrc) {
      logger.withTag('frameCapture').debug('CORS video cache invalidated (src changed)');
      disposeCloneEntry(cached);
      corsVideoCache.delete(video);
    } else if (cached.corsVideo === null) {
      // CORS previously failed for this source - don't retry
      return video;
    } else {
      // Keep a playing clone decoding alongside the page video. Firefox can
      // take seconds to service a network-backed seek even when adjacent media
      // is already buffered; leaving the clone paused forced every playback
      // sample through that slow path. We still verify the selected media time
      // before drawing, so the pixels retain the Frame Sample's identity.
      try {
        await waitForVideoFrameAt(cached.corsVideo, timestampSec, CORS_VIDEO_SEEK_TIMEOUT_MS);
        mirrorVideoPlayback(video, cached.corsVideo);
        return cached.corsVideo;
      } catch (error) {
        // Reddit reuses/reparents players; Firefox can leave the old paused
        // clone without a terminal seeked/error event. Never let that stale
        // decoder poison every later Frame Sample.
        disposeCloneEntry(cached);
        corsVideoCache.delete(video);
        throw error;
      }
    }
  }

  const pending = inflightClones.get(video);
  if (pending) {
    await pending;
    return ensureCorsSafeSource(video, timestampSec);
  }
  const creation = createTieredClone(video, actualSrc, timestampSec).finally(() => inflightClones.delete(video));
  inflightClones.set(video, creation);
  return creation;
}

/** Tier 2 then Tier 3; caches the outcome (including permanent failure) per video. */
async function createTieredClone(
  video: HTMLVideoElement,
  actualSrc: string,
  timestampSec: number,
): Promise<HTMLVideoElement> {
  // Tier 2: CORS clone (rare path - server supports CORS but page forgot crossOrigin attr)
  logger.withTag('frameCapture').debug('Attempting CORS video workaround for:', actualSrc);
  try {
    const corsVideo = await createCloneVideo(video, actualSrc, timestampSec, { crossOrigin: true });
    logger.withTag('frameCapture').info('CORS video workaround succeeded');
    corsVideoCache.set(video, { corsVideo, src: actualSrc });
    return corsVideo;
  } catch (error) {
    if (error instanceof CaptureStageTimeoutError) {
      // A timeout is transient (network/decoder stall), not proof that CORS is
      // permanently unsupported. Leave the cache empty so a later sample can retry.
      throw error;
    }
    logger.withTag('frameCapture').debug('CORS video workaround failed (expected for most videos):', error);
  }

  // Tier 3: Relay Fetch - the background fetches the bytes CORS-exempt and the
  // clone plays them from a page-origin blob: URL, so the canvas stays clean.
  const blobUrl = await relayFetchBlobUrl(actualSrc);
  if (!blobUrl) {
    corsVideoCache.set(video, { corsVideo: null, src: actualSrc });
    return video;
  }
  try {
    const relayVideo = await createCloneVideo(video, blobUrl, timestampSec, { crossOrigin: false });
    logger.withTag('frameCapture').info('Relay Fetch workaround succeeded');
    corsVideoCache.set(video, { corsVideo: relayVideo, src: actualSrc, blobUrl });
    return relayVideo;
  } catch (error) {
    URL.revokeObjectURL(blobUrl);
    if (error instanceof CaptureStageTimeoutError) {
      throw error;
    }
    logger.withTag('frameCapture').debug('Relay Fetch clone failed:', error);
    corsVideoCache.set(video, { corsVideo: null, src: actualSrc });
    return video;
  }
}

/**
 * Relay Fetch the bytes via background and mint a page-origin blob: URL, or
 * null on failure. Base64 because browser.runtime JSON-serializes ArrayBuffers away.
 */
async function relayFetchBlobUrl(src: string): Promise<string | null> {
  try {
    const base64 = await backgroundRpc.fetchMediaBytes(src);
    if (!base64) return null;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mediaMimeType(src) }));
  } catch (error) {
    logger.withTag('frameCapture').debug('Relay Fetch failed:', error);
    return null;
  }
}

/** Some servers mislabel media (e.g. `Content-Type: webm` without the `video/` prefix), so type from the URL extension. */
function mediaMimeType(src: string): string {
  const extension = /\.(\w+)(?:$|[?#])/.exec(src)?.[1]?.toLowerCase();
  switch (extension) {
    case 'webm':
      return 'video/webm';
    case 'ogv':
      return 'video/ogg';
    default:
      return 'video/mp4';
  }
}

function disposeCloneEntry(entry: CorsVideoEntry): void {
  if (entry.corsVideo) {
    entry.corsVideo.removeAttribute('src');
    entry.corsVideo.load(); // Force unload
  }
  if (entry.blobUrl) {
    URL.revokeObjectURL(entry.blobUrl);
  }
}

/**
 * Release cached CORS video for cleanup.
 * Call when disposing a video element to free resources.
 */
export function releaseCorsVideoCache(video: HTMLVideoElement): void {
  const cached = corsVideoCache.get(video);
  if (cached) disposeCloneEntry(cached);
  corsVideoCache.delete(video);
}

export function createDrawingSurface(
  video: HTMLVideoElement,
  maxDimension = Number.POSITIVE_INFINITY,
): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  width: number;
  height: number;
} {
  const canvas = document.createElement('canvas');
  const nativeWidth = video.videoWidth || video.clientWidth || 0;
  const nativeHeight = video.videoHeight || video.clientHeight || 0;
  const longestSide = Math.max(nativeWidth, nativeHeight);
  const scale = longestSide > maxDimension ? maxDimension / longestSide : 1;
  const width = Math.round(nativeWidth * scale);
  const height = Math.round(nativeHeight * scale);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return { canvas, ctx, width, height };
}

async function extractPosterImage(posterUrl: string): Promise<ImageBitmap | null> {
  const img = new Image();
  try {
    img.crossOrigin = 'anonymous';

    const loaded = new Promise<HTMLImageElement>((resolve, reject) => {
      img.onload = () => {
        resolve(img);
      };

      img.onerror = () => {
        reject(new Error('Failed to load poster image'));
      };

      img.src = posterUrl;
    });
    await withStageTimeout(loaded, 'Thumbnail poster load', POSTER_LOAD_TIMEOUT_MS);
    return await withStageTimeout(
      createImageBitmap(img),
      'Thumbnail poster bitmap creation',
      BITMAP_CREATE_TIMEOUT_MS,
      late => late.close(),
    );
  } catch (error) {
    logger.withTag('frameCapture').debug('Error extracting poster image:', error);
    return null;
  } finally {
    img.onload = null;
    img.onerror = null;
    img.removeAttribute('src');
  }
}

async function createCloneVideo(
  originalVideo: HTMLVideoElement,
  srcUrl: string,
  timestampSec: number,
  { crossOrigin }: { crossOrigin: boolean },
): Promise<HTMLVideoElement> {
  const corsVideo = document.createElement('video');
  if (crossOrigin) corsVideo.setAttribute('crossorigin', 'anonymous');
  corsVideo.preload = 'auto';
  corsVideo.muted = true;
  corsVideo.playsInline = true;
  corsVideo.src = srcUrl;
  corsVideo.currentTime = timestampSec;

  const loaded = new Promise<HTMLVideoElement>((resolve, reject) => {
    if (corsVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && corsVideo.videoHeight) {
      resolve(corsVideo);
      return;
    }

    corsVideo.onloadeddata = () => {
      if (corsVideo.videoHeight) {
        resolve(corsVideo);
      } else {
        reject(new Error('CORS video has no height data'));
      }
    };

    corsVideo.onerror = () => {
      reject(new Error('Failed to load CORS-enabled video element'));
    };
  });
  try {
    await withStageTimeout(loaded, 'CORS video load', CORS_VIDEO_LOAD_TIMEOUT_MS);
    // `loadeddata` only promises that some current frame exists. In
    // particular, Firefox may first expose time zero after a pre-metadata
    // currentTime assignment. Do not cache or report success until the clone
    // has observably reached the frame requested by this capture.
    await waitForVideoFrameAt(corsVideo, timestampSec, CORS_VIDEO_SEEK_TIMEOUT_MS);
    mirrorVideoPlayback(originalVideo, corsVideo);
    return corsVideo;
  } catch (error) {
    corsVideo.onloadeddata = null;
    corsVideo.onerror = null;
    corsVideo.removeAttribute('src');
    corsVideo.load();
    throw error;
  }
}

/** Match the source's decode direction after the selected frame is ready. */
function mirrorVideoPlayback(source: HTMLVideoElement, clone: HTMLVideoElement): void {
  clone.loop = source.loop;
  clone.playbackRate = source.playbackRate;
  if (source.paused || source.ended) {
    clone.pause();
    return;
  }
  // The clone is muted, so normal autoplay policy permits this. A rejection is
  // harmless: the next sample falls back to the bounded exact-seek path.
  void clone.play().catch(error => {
    logger.withTag('frameCapture').debug('Could not keep CORS video clone playing:', error);
  });
}

/**
 * Resolve once the CORS decoder displays the requested sample. Firefox can
 * omit `seeked` after player churn, so ready state is also polled; the wait is
 * always bounded and cleans up every listener/timer.
 */
export async function waitForVideoFrameAt(
  video: HTMLVideoElement,
  timestampSec: number,
  timeoutMs = CORS_VIDEO_SEEK_TIMEOUT_MS,
): Promise<void> {
  const isReady = () =>
    !video.seeking &&
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    Math.abs(video.currentTime - timestampSec) <= VIDEO_TIME_TOLERANCE_SEC;
  if (isReady()) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('loadeddata', onSeeked);
      video.removeEventListener('error', onError);
      clearInterval(pollId);
      clearTimeout(timeoutId);
    };
    const onSeeked = () => {
      if (isReady()) {
        cleanup();
        resolve();
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error('CORS video failed while seeking to Frame Sample'));
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('loadeddata', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    const pollId = setInterval(onSeeked, 50);
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new CaptureStageTimeoutError('CORS video seek', timeoutMs));
    }, timeoutMs);
    try {
      video.currentTime = timestampSec;
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
