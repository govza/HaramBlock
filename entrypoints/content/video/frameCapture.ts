import { logger } from '@/utils/logger';

// Cache CORS videos per original video element to avoid re-creating on every frame
// Stores either the cached CORS video or null if CORS failed (to avoid retrying)
type CorsVideoEntry = { corsVideo: HTMLVideoElement; src: string } | { corsVideo: null; src: string };
const corsVideoCache = new WeakMap<HTMLVideoElement, CorsVideoEntry>();

export async function captureThumbnailBitmap(video: HTMLVideoElement): Promise<ImageBitmap | null> {
  if (video.poster) {
    try {
      const posterBitmap = await extractPosterImage(video.poster);
      if (posterBitmap) {
        return posterBitmap;
      }
    } catch (error) {
      logger.withTag('frameCapture').debug('Failed to extract poster image, falling back to video frame:', error);
    }
  }

  // Fail closed: below HAVE_CURRENT_DATA drawImage silently draws nothing, and a
  // transparent capture would be verdicted "safe" for content nobody analyzed.
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    logger.withTag('frameCapture').debug('No current frame data, cannot extract thumbnail');
    return null;
  }

  const { canvas, ctx, width, height } = createDrawingSurface(video);
  if (!ctx || width === 0 || height === 0) {
    logger.withTag('frameCapture').warn('Video has zero dimensions, cannot extract thumbnail');
    return null;
  }

  const sourceVideo = await ensureCorsSafeSource(video);
  ctx.drawImage(sourceVideo, 0, 0, width, height);

  try {
    return createImageBitmap(canvas);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'SecurityError') {
      logger.withTag('frameCapture').warn('Cannot create bitmap from cross-origin video canvas');
      return null;
    }
    throw error;
  }
}

export async function captureFrameBitmap(video: HTMLVideoElement): Promise<ImageBitmap | null> {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    logger.withTag('frameCapture').debug('Skipping frame capture, no current frame data');
    return null;
  }

  const { canvas, ctx, width, height } = createDrawingSurface(video);
  if (!ctx || width === 0 || height === 0) {
    logger.withTag('frameCapture').debug('Skipping frame capture due to zero dimensions');
    return null;
  }

  const sourceVideo = await ensureCorsSafeSource(video);
  ctx.drawImage(sourceVideo, 0, 0, width, height);

  try {
    return createImageBitmap(canvas);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'SecurityError') {
      logger.withTag('frameCapture').warn('Cannot create bitmap from cross-origin video canvas');
      return null;
    }
    throw error;
  }
}

export async function ensureCorsSafeSource(video: HTMLVideoElement): Promise<HTMLVideoElement> {
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
      // Reuse cached CORS video, just sync currentTime
      cached.corsVideo.currentTime = video.currentTime;
      return cached.corsVideo;
    }
  }

  // Create and cache new CORS video (rare path - server supports CORS but page forgot crossOrigin attr)
  logger.withTag('frameCapture').debug('Attempting CORS video workaround for:', actualSrc);
  try {
    const corsVideo = await createCORSVideo(video);
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

export function createDrawingSurface(video: HTMLVideoElement): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  width: number;
  height: number;
} {
  const canvas = document.createElement('canvas');
  const width = video.videoWidth || video.clientWidth || 0;
  const height = video.videoHeight || video.clientHeight || 0;
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

async function createCORSVideo(originalVideo: HTMLVideoElement): Promise<HTMLVideoElement> {
  const corsVideo = document.createElement('video');
  corsVideo.setAttribute('crossorigin', 'anonymous');
  corsVideo.src = originalVideo.currentSrc || originalVideo.src;
  corsVideo.muted = true;
  corsVideo.currentTime = originalVideo.currentTime;

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
