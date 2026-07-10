import { logger } from '@/utils/logger';
import { backgroundRpc } from '@/utils/messaging/content';
import { onModelSettingsChange } from '@/utils/modelSettings';

// Cache CORS videos per original video element to avoid re-creating on every frame
// Stores either the cached CORS video or null if CORS failed (to avoid retrying)
type CorsVideoEntry = { corsVideo: HTMLVideoElement; src: string } | { corsVideo: null; src: string };
const corsVideoCache = new WeakMap<HTMLVideoElement, CorsVideoEntry>();

/**
 * A permanent failure (canvas taint) can never succeed for this source, so the
 * session finalizes as allow; a transient one (no frame data yet) may succeed
 * on a later attempt, so the session stays fail-closed while retrying.
 */
export type CaptureResult =
  | { bitmap: ImageBitmap; failure?: never }
  | { bitmap?: never; failure: 'permanent' | 'transient' };

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

  try {
    return { bitmap: await createImageBitmap(canvas) };
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

  if (video.crossOrigin || actualSrc.startsWith('blob:')) {
    return video;
  }

  // Check cache first
  const cached = corsVideoCache.get(video);
  if (cached) {
    // Invalidate cache if source changed
    if (cached.src !== actualSrc) {
      logger.withTag('frameCapture').debug('CORS video cache invalidated (src changed)');
      if (cached.corsVideo) {
        cached.corsVideo.src = '';
        cached.corsVideo.load(); // Force unload
      }
      corsVideoCache.delete(video);
    } else if (cached.corsVideo === null) {
      // CORS previously failed for this source - don't retry
      return video;
    } else {
      // The clone is a seekable decoder, not a live mirror. Wait until it is
      // actually presenting the Frame Sample's selected media time before draw.
      await seekCorsVideo(cached.corsVideo, timestampSec);
      return cached.corsVideo;
    }
  }

  // Create and cache new CORS video (rare path - server supports CORS but page forgot crossOrigin attr)
  logger.withTag('frameCapture').debug('Attempting CORS video workaround for:', actualSrc);
  try {
    const corsVideo = await createCORSVideo(video, timestampSec);
    logger.withTag('frameCapture').info('CORS video workaround succeeded');
    corsVideoCache.set(video, { corsVideo, src: actualSrc });
    return corsVideo;
  } catch (error) {
    // Cache the failure to avoid retrying - this is the common case (server doesn't support CORS)
    logger.withTag('frameCapture').debug('CORS video workaround failed (expected for most videos):', error);
    corsVideoCache.set(video, { corsVideo: null, src: actualSrc });
    return video;
  }
}

/**
 * Release cached CORS video for cleanup.
 * Call when disposing a video element to free resources.
 */
export function releaseCorsVideoCache(video: HTMLVideoElement): void {
  const cached = corsVideoCache.get(video);
  if (cached?.corsVideo) {
    cached.corsVideo.src = '';
    cached.corsVideo.load(); // Force unload
  }
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
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    return new Promise<ImageBitmap>((resolve, reject) => {
      img.onload = async () => {
        try {
          const bitmap = await createImageBitmap(img);
          resolve(bitmap);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      img.onerror = () => {
        reject(new Error('Failed to load poster image'));
      };

      img.src = posterUrl;
    });
  } catch (error) {
    logger.withTag('frameCapture').debug('Error extracting poster image:', error);
    return null;
  }
}

async function createCORSVideo(originalVideo: HTMLVideoElement, timestampSec: number): Promise<HTMLVideoElement> {
  const corsVideo = document.createElement('video');
  corsVideo.setAttribute('crossorigin', 'anonymous');
  corsVideo.src = originalVideo.currentSrc || originalVideo.src;
  corsVideo.muted = true;
  corsVideo.currentTime = timestampSec;

  return new Promise<HTMLVideoElement>((resolve, reject) => {
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
}

/** Resolve only once the cached CORS decoder displays the requested sample. */
async function seekCorsVideo(video: HTMLVideoElement, timestampSec: number): Promise<void> {
  if (Math.abs(video.currentTime - timestampSec) < 0.001 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('CORS video failed while seeking to Frame Sample'));
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = timestampSec;
  });
}
