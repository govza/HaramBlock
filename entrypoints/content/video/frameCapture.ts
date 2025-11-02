import { logger } from '@/utils/logger';

export async function captureThumbnailBitmap(video: HTMLVideoElement): Promise<ImageBitmap | null> {
  if (video.poster) {
    try {
      const posterBitmap = await extractPosterImage(video.poster);
      if (posterBitmap) {
        return posterBitmap;
      }
    } catch (error) {
      logger.withTag('handleVideos').debug('Failed to extract poster image, falling back to video frame:', error);
    }
  }

  await waitForVideoReady(video);

  const { canvas, ctx, width, height } = createDrawingSurface(video);
  if (!ctx || width === 0 || height === 0) {
    logger.withTag('handleVideos').warn('Video has zero dimensions, cannot extract thumbnail');
    return null;
  }

  const sourceVideo = await ensureCorsSafeSource(video);
  ctx.drawImage(sourceVideo, 0, 0, width, height);

  const sampleWidth = Math.min(width, 50);
  const sampleHeight = Math.min(height, 50);
  const imageData = ctx.getImageData(0, 0, sampleWidth, sampleHeight);
  const pixels = imageData.data;
  let nonZeroPixels = 0;
  for (let i = 0; i + 2 < pixels.length; i += 4) {
    const r = pixels[i] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    if (r > 10 || g > 10 || b > 10) {
      nonZeroPixels++;
    }
  }
  const totalPixels = pixels.length / 4;
  const contentRatio = totalPixels ? nonZeroPixels / totalPixels : 0;

  logger.withTag('handleVideos').debug('Thumbnail extraction analysis', {
    canvasSize: `${width}x${height}`,
    videoReady: video.readyState,
    videoSize: `${video.videoWidth || 0}x${video.videoHeight || 0}`,
    currentTime: video.currentTime,
    poster: video.poster,
    contentRatio: contentRatio.toFixed(2),
    sampledPixels: totalPixels,
  });

  return createImageBitmap(canvas);
}

export async function captureFrameBitmap(video: HTMLVideoElement): Promise<ImageBitmap | null> {
  const { canvas, ctx, width, height } = createDrawingSurface(video);
  if (!ctx || width === 0 || height === 0) {
    logger.withTag('handleVideos').debug('Skipping frame capture due to zero dimensions');
    return null;
  }

  const sourceVideo = await ensureCorsSafeSource(video);
  ctx.drawImage(sourceVideo, 0, 0, width, height);

  return createImageBitmap(canvas);
}

export async function ensureCorsSafeSource(video: HTMLVideoElement): Promise<HTMLVideoElement> {
  if (video.crossOrigin || video.src.startsWith('blob:')) {
    return video;
  }

  try {
    return await createCORSVideo(video);
  } catch {
    return video;
  }
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
  const ctx = canvas.getContext('2d');
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
    logger.withTag('handleVideos').debug('Error extracting poster image:', error);
    return null;
  }
}

export async function waitForVideoReady(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth > 0 && video.videoHeight > 0) {
    return;
  }

  await new Promise<void>((resolve, _reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      logger.withTag('handleVideos').warn('Timeout waiting for video metadata');
      resolve();
    }, 3000);

    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('error', onError);
    };

    const onLoadedMetadata = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      logger.withTag('handleVideos').warn('Video error while waiting for metadata');
      resolve();
    };

    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('error', onError);

    if (video.readyState === HTMLMediaElement.HAVE_NOTHING) {
      video.load();
    }
  });
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
