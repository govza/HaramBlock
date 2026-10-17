import type { AnalysisFrame, DecodedTarget, DecodeTarget } from '@/utils/lookahead/ports';
import type { BitmapFrame } from '@/utils/lookahead/webCodecsDecoder';

export function groupTargetsByPts(targets: readonly DecodeTarget[]): Map<number, DecodeTarget[]> {
  const targetsByPts = new Map<number, DecodeTarget[]>();
  for (const target of targets) targetsByPts.set(target.ptsUs, [...(targetsByPts.get(target.ptsUs) ?? []), target]);
  return targetsByPts;
}

async function cloneFrame(frame: AnalysisFrame): Promise<AnalysisFrame> {
  const source = frame as Partial<BitmapFrame>;
  if (!source.bitmap) return frame;
  const bitmap = await createImageBitmap(source.bitmap);
  return { ...source, bitmap, close: () => bitmap.close() } as BitmapFrame;
}

/**
 * Hands one decoded frame to every target at its timestamp. Clones are taken before the first yield
 * because the consumer may close the frame it receives.
 */
export async function* fanOutToTargets(
  frame: AnalysisFrame,
  targets: readonly DecodeTarget[],
): AsyncIterable<DecodedTarget> {
  const [first, ...rest] = targets;
  if (!first) {
    frame.close();
    return;
  }
  const clones = await Promise.all(rest.map(() => cloneFrame(frame)));
  yield { target: first, frame };
  for (const [index, target] of rest.entries()) {
    const clone = clones[index];
    if (clone) yield { target, frame: clone };
  }
}
