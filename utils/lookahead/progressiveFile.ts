import { ALL_FORMATS, CustomSource, EncodedPacketSink, Input, type EncodedPacket } from 'mediabunny';

import { toEncodedSample } from '@/utils/lookahead/demux';
import { latticePointsIn, toPointUs } from '@/utils/lookahead/lattice';

import type { ByteRangeSource, DecodeJob, EncodedSample } from '@/utils/lookahead/ports';

export class UnreachableFetchError extends Error {
  override readonly name = 'UnreachableFetchError';
}

/**
 * One keyframe-to-keyframe span of a Progressive Source and the points sampled in it: Lattice Points for short GOPs,
 * only the Keyframe Point for long ones.
 */
export interface ProgressiveGop {
  startUs: number;
  endUs: number;
  points: number[];
}

/**
 * A Progressive Source opened over range reads: its GOP index and on-demand decode jobs that fetch only the packets
 * they need.
 */
export interface ProgressiveFile {
  readonly durationUs: number;
  readonly gops: readonly ProgressiveGop[];
  gopOf(pointUs: number): ProgressiveGop | undefined;
  jobFor(points: readonly number[]): Promise<DecodeJob | null>;
  dispose(): void;
}

const SHORT_GOP_MAX_US = 1_000_000;

export function gopSamplePoints(keyframePointsUs: readonly number[], durationUs: number): ProgressiveGop[] {
  return keyframePointsUs.map((startUs, index) => {
    const endUs = keyframePointsUs[index + 1] ?? durationUs;
    const points = endUs - startUs <= SHORT_GOP_MAX_US ? latticePointsIn(startUs, endUs) : [startUs];
    return { startUs, endUs, points };
  });
}

const packetUs = (packet: EncodedPacket): number => Math.round(packet.timestamp * 1e6);

export async function openProgressiveFile(bytes: ByteRangeSource): Promise<ProgressiveFile> {
  let sizeBytes: number;
  try {
    sizeBytes = await bytes.size();
  } catch (error) {
    throw new UnreachableFetchError('First range request failed', { cause: error });
  }
  const input = new Input({
    source: new CustomSource({ getSize: () => sizeBytes, read: (start, end) => bytes.read(start, end) }),
    formats: ALL_FORMATS,
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('No video track');
    const config = await track.getDecoderConfig();
    if (!config) throw new Error('No decoder config');
    const sink = new EncodedPacketSink(track);
    const keyframePointsUs: number[] = [];
    for (
      let key = await sink.getFirstKeyPacket({ metadataOnly: true });
      key;
      key = await sink.getNextKeyPacket(key, { metadataOnly: true })
    ) {
      keyframePointsUs.push(toPointUs(key.timestamp));
    }
    const durationUs = Math.round((await track.computeDuration()) * 1e6);
    const gops = gopSamplePoints(keyframePointsUs, durationUs);
    const gopOf = (pointUs: number) => gops.findLast(gop => gop.startUs <= pointUs);

    return {
      durationUs,
      gops,
      gopOf,
      async jobFor(points) {
        const [first] = points;
        if (first === undefined) return null;
        const key = await sink.getKeyPacket(first / 1e6, { verifyKeyPackets: true });
        if (!key) return null;
        const targetsBySequence = new Map<number, { pointUs: number; ptsUs: number }[]>();
        for (const pointUs of points) {
          const target = await sink.getPacket(pointUs / 1e6, { metadataOnly: true });
          if (!target) continue;
          const entry = targetsBySequence.get(target.sequenceNumber) ?? [];
          entry.push({ pointUs, ptsUs: packetUs(target) });
          targetsBySequence.set(target.sequenceNumber, entry);
        }
        if (targetsBySequence.size === 0) return null;
        const lastSequence = Math.max(...targetsBySequence.keys());
        const packets: EncodedSample[] = [];
        for (let packet: EncodedPacket | null = key; packet; packet = await sink.getNextPacket(packet)) {
          packets.push(toEncodedSample(packet));
          if (packet.sequenceNumber >= lastSequence) break;
        }
        return { config, packets, targets: [...targetsBySequence.values()].flat() };
      },
      dispose: () => input.dispose(),
    };
  } catch (error) {
    input.dispose();
    throw error;
  }
}
