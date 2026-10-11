import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input, type EncodedPacket } from 'mediabunny';

import { concat, type AnalysisUnitBytes } from '@/utils/lookahead/byteStream';

import type { EncodedSample } from '@/utils/lookahead/ports';

/**
 * An Analysis Unit demuxed into decodable packets in page media time.
 */
export interface DemuxedUnit {
  config: VideoDecoderConfig;
  packets: EncodedSample[];
  startUs: number;
  endUs: number;
}

const BOUNDARY_TOLERANCE_US = 1_000;

export const toEncodedSample = (packet: EncodedPacket, offsetUs = 0): EncodedSample => ({
  data: packet.data,
  type: packet.type,
  timestampUs: Math.round(packet.timestamp * 1e6) + offsetUs,
  durationUs: Math.round(packet.duration * 1e6),
});

function indexOfPayload(bytes: Uint8Array, payload: Uint8Array, from: number): number {
  const [firstByte] = payload;
  if (firstByte === undefined) return -1;
  for (let index = bytes.indexOf(firstByte, from); index >= 0; index = bytes.indexOf(firstByte, index + 1)) {
    if (index + payload.length > bytes.length) return -1;
    if (payload.every((byte, offset) => bytes[index + offset] === byte)) return index;
  }
  return -1;
}

function appendOffsetLocator(unit: AnalysisUnitBytes): (payload: Uint8Array) => number {
  const firstOffsetUs = unit.offsets[0]?.offsetUs ?? 0;
  if (unit.offsets.length <= 1) return () => firstOffsetUs;
  let searchFrom = 0;
  let lastOffsetUs = firstOffsetUs;
  return payload => {
    const start = indexOfPayload(unit.bytes, payload, searchFrom);
    if (start < 0) return lastOffsetUs;
    searchFrom = start + payload.length;
    const lastByte = searchFrom - 1;
    lastOffsetUs = unit.offsets.findLast(span => span.fromByte <= lastByte)?.offsetUs ?? firstOffsetUs;
    return lastOffsetUs;
  };
}

export async function demuxUnit(unit: AnalysisUnitBytes): Promise<DemuxedUnit> {
  const input = new Input({ source: new BufferSource(concat([unit.init.bytes, unit.bytes])), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('No video track in Analysis Unit');
    const config = await track.getDecoderConfig();
    if (!config) throw new Error('No decoder config for Analysis Unit');
    const offsetUsOf = appendOffsetLocator(unit);
    const packets: EncodedSample[] = [];
    for await (const packet of new EncodedPacketSink(track).packets()) {
      packets.push(toEncodedSample(packet, offsetUsOf(packet.data)));
    }
    if (packets.length === 0) throw new Error('Empty Analysis Unit');
    const startUs = Math.min(...packets.map(packet => packet.timestampUs));
    const endUs = Math.max(...packets.map(packet => packet.timestampUs + packet.durationUs)) - BOUNDARY_TOLERANCE_US;
    return { config, packets, startUs, endUs };
  } finally {
    input.dispose();
  }
}
