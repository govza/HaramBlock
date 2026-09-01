import { GIF_MAX_INFERENCE_FRAMES, GIF_MIN_INFERENCE_FRAMES, MAX_GIF_DECODE_FRAMES } from '@/utils/constants/gif';
import { getLogger } from '@/utils/telemetry';

const log = getLogger('gifDecoder');

export interface DecodedGif {
  frames: DecodedGifFrame[]; // Decoded composited playback frames
  totalFrames: number; // Total number of frames in the GIF
  width: number; // GIF display width
  height: number; // GIF display height
}

export interface DecodedGifFrame {
  bitmap: ImageBitmap;
  frameIndex: number; // Original frame index within the GIF
  durationMs: number; // Frame display duration in milliseconds
}

/**
 * Pick up to `max` frame indices spread evenly across `total`, always including
 * the first and last frame. Returns a sorted, de-duplicated list.
 */
export function sampleFrameIndices(total: number, max: number): number[] {
  if (total <= 0) return [];
  if (total <= max) {
    return Array.from({ length: total }, (_, i) => i);
  }
  const indices = new Set<number>();
  for (let i = 0; i < max; i++) {
    indices.add(Math.round((i * (total - 1)) / (max - 1)));
  }
  return [...indices].sort((a, b) => a - b);
}

export function allFrameIndices(total: number): number[] {
  if (total <= 0) return [];
  return Array.from({ length: total }, (_, i) => i);
}

/**
 * How many frames of an animated GIF to run inference on. Scales with the frame
 * count (~1 in 3) but is clamped to a floor and ceiling so short GIFs are covered
 * densely while long ones stay bounded. Used with {@link sampleFrameIndices} to
 * pick which decoded frames to inspect.
 */
export function gifInferenceFrameCap(frameCount: number): number {
  if (frameCount <= 0) return 0;
  return Math.min(GIF_MAX_INFERENCE_FRAMES, Math.max(GIF_MIN_INFERENCE_FRAMES, Math.ceil(frameCount / 3)));
}

/**
 * Decode an animated GIF into all composited playback frames using the
 * WebCodecs ImageDecoder API.
 *
 * Returns null when the data is not an animated GIF (single frame / not decodable),
 * so the caller can fall back to the normal single-image path. The caller owns the
 * returned ImageBitmaps and must close them.
 */
export async function decodeGifFrames(blob: Blob): Promise<DecodedGif | null> {
  if (typeof globalThis.ImageDecoder === 'undefined') {
    return null;
  }

  const type = blob.type || 'image/gif';
  if (!type.includes('gif')) {
    return null;
  }

  let decoder: ImageDecoder | null = null;
  try {
    const data = await blob.arrayBuffer();
    decoder = new ImageDecoder({ data, type });

    await decoder.tracks.ready;
    // Ensure the full track (and thus frameCount) is known before sampling.
    await decoder.completed;

    const track = decoder.tracks.selectedTrack;
    if (!track || !track.animated || track.frameCount <= 1) {
      return null;
    }

    if (track.frameCount > MAX_GIF_DECODE_FRAMES) {
      log.debug('gif.decode.frame_cap', { frameCount: track.frameCount, decodedFrames: MAX_GIF_DECODE_FRAMES });
    }
    const frameIndices = allFrameIndices(Math.min(track.frameCount, MAX_GIF_DECODE_FRAMES));
    const frames: DecodedGifFrame[] = [];
    let width = 0;
    let height = 0;

    try {
      for (const frameIndex of frameIndices) {
        // GIF frames must be decoded in frame order so disposal/composition is correct.
        // eslint-disable-next-line no-await-in-loop
        const { image } = await decoder.decode({ frameIndex, completeFramesOnly: true });
        width = image.displayWidth;
        height = image.displayHeight;
        try {
          frames.push({
            // eslint-disable-next-line no-await-in-loop
            bitmap: await createImageBitmap(image),
            frameIndex,
            durationMs: getFrameDurationMs(image),
          });
        } finally {
          image.close();
        }
      }
    } catch (error) {
      // Release any frames decoded before the failure to avoid leaking bitmaps.
      frames.forEach(frame => frame.bitmap.close());
      throw error;
    }

    if (frames.length === 0) {
      return null;
    }

    return { frames, totalFrames: track.frameCount, width, height };
  } catch (error) {
    log.debug('gif.decode.failed', { error });
    return null;
  } finally {
    decoder?.close();
  }
}

function getFrameDurationMs(frame: VideoFrame): number {
  const durationUs = frame.duration;
  if (durationUs === null || !Number.isFinite(durationUs) || durationUs <= 0) {
    return 100;
  }
  return Math.max(20, Math.round(durationUs / 1000));
}
