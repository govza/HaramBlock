import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input, type EncodedPacket } from 'mediabunny';

import { concat, type AnalysisUnitBytes } from '@/utils/lookahead/byteStream';

import type { EncodedSample } from '@/utils/lookahead/ports';

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

export async function demuxUnit(unit: AnalysisUnitBytes, offsetUs: number): Promise<DemuxedUnit> {
  const input = new Input({ source: new BufferSource(concat([unit.init.bytes, unit.bytes])), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('No video track in Analysis Unit');
    const config = await track.getDecoderConfig();
    if (!config) throw new Error('No decoder config for Analysis Unit');
    const packets: EncodedSample[] = [];
    for await (const packet of new EncodedPacketSink(track).packets()) packets.push(toEncodedSample(packet, offsetUs));
    if (packets.length === 0) throw new Error('Empty Analysis Unit');
    const startUs = Math.min(...packets.map(packet => packet.timestampUs));
    const endUs = Math.max(...packets.map(packet => packet.timestampUs + packet.durationUs)) - BOUNDARY_TOLERANCE_US;
    return { config, packets, startUs, endUs };
  } finally {
    input.dispose();
  }
}
