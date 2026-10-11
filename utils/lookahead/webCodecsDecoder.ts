import type { AnalysisFrame, DecodedTarget, DecodeJob, DecoderPort } from '@/utils/lookahead/ports';

/**
 * A decoded frame downscaled to the model input as a transferable bitmap, keeping the source dimensions for mask
 * mapping.
 */
export interface BitmapFrame extends AnalysisFrame {
  bitmap: ImageBitmap;
  originalWidth: number;
  originalHeight: number;
}

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
): DecoderPort {
  return {
    async *decode(job: DecodeJob): AsyncIterable<DecodedTarget> {
      const config: VideoDecoderConfig = { ...job.config, hardwareAcceleration, optimizeForLatency: true };
      const support = await VideoDecoder.isConfigSupported(config);
      if (!support.supported) throw new Error(`Unsupported codec ${job.config.codec}`);
      const targetsByPts = new Map<number, DecodeJob['targets']>();
      for (const target of job.targets)
        targetsByPts.set(target.ptsUs, [...(targetsByPts.get(target.ptsUs) ?? []), target]);
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
        const targets = targetsByPts.get(converted.ptsUs) ?? [];
        const [first, ...rest] = targets;
        if (!first) {
          converted.frame.close();
          continue;
        }
        if (rest.length === 0) {
          yield { target: first, frame: converted.frame };
          continue;
        }
        const clones = await Promise.all(targets.map(() => cloneFrame(converted.frame)));
        converted.frame.close();
        for (const [index, target] of targets.entries()) {
          const clone = clones[index];
          if (clone) yield { target, frame: clone };
        }
      }
    },
  };
}

async function closeConverted(conversions: readonly Promise<{ frame: AnalysisFrame }>[]): Promise<void> {
  for (const result of await Promise.allSettled(conversions)) {
    if (result.status === 'fulfilled') result.value.frame.close();
  }
}

async function cloneFrame(frame: AnalysisFrame): Promise<AnalysisFrame> {
  const source = frame as Partial<BitmapFrame>;
  if (!source.bitmap) return frame;
  const bitmap = await createImageBitmap(source.bitmap);
  return { ...source, bitmap, close: () => bitmap.close() } as BitmapFrame;
}
