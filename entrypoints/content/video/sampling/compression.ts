import { PermanentFrameTransferError, isWriteOnlyCanvasError } from '@/entrypoints/content/video/sampling/transfer';

let compressionCanvas: OffscreenCanvas | null = null;
let compressionLease: Promise<unknown> = Promise.resolve();

/**
 * Shared compression surface for the Firefox blob transport, reused across
 * samples (~4/s per video) to avoid per-sample OffscreenCanvas allocation
 * churn; resized only when dimensions change. Concurrent callers are
 * serialized on a lease so no caller can repaint the surface before the
 * previous one's blob conversion settles.
 */
export function bitmapToCompressedBlob(bitmap: ImageBitmap): Promise<Blob> {
  const result = compressionLease.then(() => compressToBlob(bitmap));
  compressionLease = result.catch(() => undefined);
  return result;
}

async function compressToBlob(bitmap: ImageBitmap): Promise<Blob> {
  if (!compressionCanvas) {
    compressionCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  } else if (compressionCanvas.width !== bitmap.width || compressionCanvas.height !== bitmap.height) {
    compressionCanvas.width = bitmap.width;
    compressionCanvas.height = bitmap.height;
  }
  const ctx = compressionCanvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get 2D context for video frame compression');
  }
  ctx.drawImage(bitmap, 0, 0);
  try {
    return await compressionCanvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
  } catch (error) {
    if (isWriteOnlyCanvasError(error)) {
      throw new PermanentFrameTransferError('Video frame canvas is cross-origin and cannot be serialized', {
        cause: error,
      });
    }
    throw error;
  }
}
