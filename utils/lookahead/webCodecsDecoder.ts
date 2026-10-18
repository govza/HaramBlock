import { fanOutToTargets, groupTargetsByPts } from '@/utils/lookahead/targetFanOut';

import type { AnalysisFrame, CapableDecoder, DecodedTarget, DecodeJob, InferredSample } from '@/utils/lookahead/ports';

/**
 * A decoded frame downscaled to the model input as a transferable bitmap, keeping the source dimensions for mask
 * mapping.
 */
export interface BitmapFrame extends AnalysisFrame {
  bitmap: ImageBitmap;
  originalWidth: number;
  originalHeight: number;
}

export const withSourceSize = (
  sample: InferredSample,
  { originalWidth, originalHeight }: Pick<BitmapFrame, 'originalWidth' | 'originalHeight'>,
): InferredSample => ({ ...sample, source: { width: originalWidth, height: originalHeight } });

export async function toModelInputBitmap(frame: VideoFrame, inputSize: number): Promise<BitmapFrame> {
  const originalWidth = frame.displayWidth;
  const originalHeight = frame.displayHeight;
  const scale = Math.min(1, inputSize / Math.max(originalWidth, originalHeight));
  try {
    const bitmap = await createImageBitmap(frame, {
      resizeWidth: Math.max(1, Math.round(originalWidth * scale)),
      resizeHeight: Math.max(1, Math.round(originalHeight * scale)),
      resizeQuality: 'low',
    });
    return { bitmap, originalWidth, originalHeight, close: () => bitmap.close() };
  } finally {
    frame.close();
  }
}

export function createWebCodecsDecoder(
  toFrame: (frame: VideoFrame) => Promise<AnalysisFrame>,
  hardwareAcceleration: HardwareAcceleration = 'no-preference',
): CapableDecoder {
  const configFor = (config: VideoDecoderConfig): VideoDecoderConfig => ({
    ...config,
    hardwareAcceleration,
    optimizeForLatency: true,
  });
  const supports = async (config: VideoDecoderConfig): Promise<boolean> => {
    if (typeof VideoDecoder !== 'function') return false;
    try {
      return (await VideoDecoder.isConfigSupported(configFor(config))).supported === true;
    } catch {
      return false;
    }
  };
  return {
    kind: 'webcodecs',
    supports,
    async *decode(job: DecodeJob): AsyncIterable<DecodedTarget> {
      const config = configFor(job.config);
      const targetsByPts = groupTargetsByPts(job.targets);
      const conversions: Promise<{ ptsUs: number; frame: AnalysisFrame }>[] = [];
      const failure: { error: Error | null } = { error: null };
      const decoder = new VideoDecoder({
        output: frame => {
          if (!targetsByPts.has(frame.timestamp)) {
            frame.close();
            return;
          }
          const ptsUs = frame.timestamp;
          conversions.push(toFrame(frame).then(converted => ({ ptsUs, frame: converted })));
        },
        error: error => {
          failure.error = error;
        },
      });
      try {
        decoder.configure(config);
        for (const packet of job.packets) {
          decoder.decode(
            new EncodedVideoChunk({
              type: packet.type,
              timestamp: packet.timestampUs,
              duration: packet.durationUs,
              data: packet.data,
            }),
          );
        }
        await decoder.flush();
        if (failure.error) throw failure.error;
      } catch (error) {
        await closeConverted(conversions);
        throw error;
      } finally {
        if (decoder.state !== 'closed') decoder.close();
      }
      for (const converted of await Promise.all(conversions)) {
        yield* fanOutToTargets(converted.frame, targetsByPts.get(converted.ptsUs) ?? []);
      }
    },
  };
}

async function closeConverted(conversions: readonly Promise<{ frame: AnalysisFrame }>[]): Promise<void> {
  for (const result of await Promise.allSettled(conversions)) {
    if (result.status === 'fulfilled') result.value.frame.close();
  }
}
