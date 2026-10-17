import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { compileFunction } from 'node:vm';

import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from 'mediabunny';
import { describe, expect, it } from 'vitest';

import { fixture } from '@/utils/lookahead/__tests__/harness';
import { WASM_FACTORY_NAMES, wasmCodecOf, type WasmCodec, type WasmDecoderFactory } from '@/utils/lookahead/wasmCodecs';
import { WasmDecodeSession, type WasmDecodedFrame } from '@/utils/lookahead/wasmDecodeCore';

const WASM_DIR = resolve(__dirname, '../../../public/wasm-decoders');

async function loadDecoder(codec: WasmCodec) {
  const file = resolve(WASM_DIR, `${codec}.js`);
  const module = { exports: {} as Record<string, WasmDecoderFactory> };
  const load = compileFunction(readFileSync(file, 'utf8'), [
    'module',
    'exports',
    'require',
    '__filename',
    '__dirname',
  ]) as (...args: unknown[]) => void;
  load(module, module.exports, createRequire(file), file, dirname(file));
  const factory =
    (module.exports as unknown as WasmDecoderFactory | undefined) ?? module.exports[WASM_FACTORY_NAMES[codec]];
  if (typeof factory !== 'function') throw new Error(`No factory exported for ${codec}`);
  return factory();
}

async function demuxFile(name: string) {
  const input = new Input({ source: new BufferSource(fixture(name)), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error(`No video track in ${name}`);
  const config = await track.getDecoderConfig();
  if (!config) throw new Error(`No decoder config in ${name}`);
  const packets: { data: Uint8Array; timestampUs: number; type: 'key' | 'delta' }[] = [];
  for await (const packet of new EncodedPacketSink(track).packets()) {
    packets.push({ data: packet.data, timestampUs: Math.round(packet.timestamp * 1e6), type: packet.type });
  }
  input.dispose();
  const { description } = config;
  const extradata =
    description && ArrayBuffer.isView(description)
      ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
      : null;
  return { config, packets, extradata };
}

const meanOf = (data: Uint8ClampedArray) => data.reduce((sum, value) => sum + value, 0) / data.length;

describe.each([
  ['progressive-vp9.webm', 'vp9'],
  ['progressive-av1.webm', 'av1'],
] as const)('WasmDecodeSession on %s', (name, codec) => {
  it('decodes exactly the target frames, by pts, with real pixels', async () => {
    const { config, packets, extradata } = await demuxFile(name);
    expect(wasmCodecOf(config.codec)).toBe(codec);
    const presentation = packets.map(packet => packet.timestampUs).sort((a, b) => a - b);
    const targetPtsUs = [presentation[0], presentation[3], presentation[8]].filter(pts => pts !== undefined);
    const session = new WasmDecodeSession(await loadDecoder(codec));
    const frames: WasmDecodedFrame[] = [];
    session.decode({ extradata, packets, targetPtsUs, inputSize: 32 }, frame => frames.push(frame));

    expect(frames.map(frame => frame.ptsUs).sort((a, b) => a - b)).toEqual(targetPtsUs);
    for (const frame of frames) {
      expect(Math.max(frame.image.width, frame.image.height)).toBe(32);
      expect(frame.originalWidth).toBeGreaterThan(32);
      expect(meanOf(frame.image.data)).toBeGreaterThan(40);
    }
  });

  it('decodes a second run from a later keyframe after reset', async () => {
    const { packets, extradata } = await demuxFile(name);
    const session = new WasmDecodeSession(await loadDecoder(codec));
    session.decode({ extradata, packets, targetPtsUs: [], inputSize: 64 }, () => {});
    const keyIndexes = packets.flatMap((packet, index) => (packet.type === 'key' ? [index] : []));
    const from = keyIndexes.at(-1) ?? 0;
    const run = packets.slice(from);
    const target = Math.max(...run.map(packet => packet.timestampUs));
    const frames: WasmDecodedFrame[] = [];
    session.decode({ extradata, packets: run, targetPtsUs: [target], inputSize: 64 }, frame => frames.push(frame));
    expect(frames.map(frame => frame.ptsUs)).toEqual([target]);
  });
});

describe('WasmDecodeSession pixel formats', () => {
  it('rejects non-4:2:0 frames (VP9 profile 1 RGB) instead of misreading them', async () => {
    const { packets, extradata } = await demuxFile('mse-vp9.webm');
    const session = new WasmDecodeSession(await loadDecoder('vp9'));
    const [first] = packets;
    const run = { extradata, packets, targetPtsUs: first ? [first.timestampUs] : [], inputSize: 32 };
    expect(() => session.decode(run, () => {})).toThrow('Unsupported pixel format');
  });
});
