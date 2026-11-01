import { describe, expect, it } from 'vitest';

import { wasmCodecOf } from '@/utils/lookahead/wasmCodecs';

describe('wasmCodecOf', () => {
  it.each([
    ['avc1.42001e', 'h264'],
    ['avc1.4d401f', 'h264'],
    ['avc1.640028', 'h264'],
    ['avc3.640028', 'h264'],
    ['AVC1.4D401E', 'h264'],
    ['avc1', 'h264'],
    ['vp09.00.10.08', 'vp9'],
    ['av01.0.05M.08', 'av1'],
  ])('maps %s to %s', (codec, expected) => {
    expect(wasmCodecOf(codec)).toBe(expected);
  });

  it.each(['avc1.6e0028', 'avc1.7a0028', 'avc1.f40028', 'avc1.2c0028', 'hev1.1.6.L93.B0', 'mp4a.40.2'])(
    'rejects %s, which the WASM decoders cannot output as 8-bit I420',
    codec => {
      expect(wasmCodecOf(codec)).toBeNull();
    },
  );
});
