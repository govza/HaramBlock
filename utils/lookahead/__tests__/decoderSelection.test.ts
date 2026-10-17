import { describe, expect, it, vi } from 'vitest';

import { createFirstSupportingDecoder } from '@/utils/lookahead/decoderSelection';

import type { CapableDecoder, DecodedTarget, DecodeJob } from '@/utils/lookahead/ports';

const job = (codec: string): DecodeJob => ({
  config: { codec },
  packets: [],
  targets: [{ pointUs: 0, ptsUs: 0 }],
});

function fakeDecoder(name: string, supported: readonly string[]) {
  const decoded: string[] = [];
  const supports = vi.fn((config: VideoDecoderConfig) => Promise.resolve(supported.includes(config.codec)));
  const decoder: CapableDecoder = {
    kind: name === 'native' ? 'webcodecs' : 'wasm',
    supports,
    decode: (decodeJob: DecodeJob): AsyncIterable<DecodedTarget> => {
      decoded.push(`${name}:${decodeJob.config.codec}`);
      const targets = decodeJob.targets.map(target => ({ target, frame: { close: () => {} } }));
      return (async function* () {
        yield* await Promise.resolve(targets);
      })();
    },
  };
  return { decoder, decoded, supports };
}

const drain = async (iterable: AsyncIterable<DecodedTarget>) => {
  const out: DecodedTarget[] = [];
  for await (const item of iterable) out.push(item);
  return out;
};

describe('createFirstSupportingDecoder', () => {
  it('prefers the native decoder when it supports the codec', async () => {
    const native = fakeDecoder('native', ['vp09.00.10.08']);
    const wasm = fakeDecoder('wasm', ['vp09.00.10.08']);
    await drain(createFirstSupportingDecoder([native.decoder, wasm.decoder]).decode(job('vp09.00.10.08')));
    expect(native.decoded).toEqual(['native:vp09.00.10.08']);
    expect(wasm.decoded).toEqual([]);
  });

  it('falls back to the WASM decoder when native rejects the codec', async () => {
    const native = fakeDecoder('native', []);
    const wasm = fakeDecoder('wasm', ['av01.0.05M.08']);
    const frames = await drain(
      createFirstSupportingDecoder([native.decoder, wasm.decoder]).decode(job('av01.0.05M.08')),
    );
    expect(wasm.decoded).toEqual(['wasm:av01.0.05M.08']);
    expect(frames).toHaveLength(1);
  });

  it('fails the job when no decoder supports the codec', async () => {
    const decoder = createFirstSupportingDecoder([fakeDecoder('native', []).decoder, fakeDecoder('wasm', []).decoder]);
    await expect(drain(decoder.decode(job('vp8')))).rejects.toThrow('Unsupported codec vp8');
  });

  it('probes support once per codec string', async () => {
    const native = fakeDecoder('native', []);
    const wasm = fakeDecoder('wasm', ['av01.0.05M.08']);
    const decoder = createFirstSupportingDecoder([native.decoder, wasm.decoder]);
    await drain(decoder.decode(job('av01.0.05M.08')));
    await drain(decoder.decode(job('av01.0.05M.08')));
    expect(native.supports).toHaveBeenCalledTimes(1);
    expect(wasm.decoded).toHaveLength(2);
  });
});
