import { afterEach, describe, expect, it, vi } from 'vitest';

import { lookaheadDecoder, type InferenceSite } from '@/utils/lookahead/decoderSelection';
import { toModelInputBitmap } from '@/utils/lookahead/webCodecsDecoder';

const fakeBitmap = () => {
  const close = vi.fn();
  return { bitmap: { width: 64, height: 36, close } as unknown as ImageBitmap, close };
};

const fakeFrame = () => {
  const close = vi.fn();
  return { frame: { displayWidth: 1280, displayHeight: 720, close } as unknown as VideoFrame, close };
};

class FakeOffscreenCanvas {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  getContext() {
    return { drawImage: vi.fn(), getImageData: () => ({}) };
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('toModelInputBitmap', () => {
  it('hands over the resized bitmap as decoded without a readback', async () => {
    const resized = fakeBitmap();
    const createImageBitmap = vi.fn(() => Promise.resolve(resized.bitmap));
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    const frame = fakeFrame();

    const converted = await toModelInputBitmap(frame.frame, 64, 'as-decoded');

    expect(converted.bitmap).toBe(resized.bitmap);
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    expect(frame.close).toHaveBeenCalled();
  });

  it('copies the resized bitmap into CPU memory and closes the GPU-backed one', async () => {
    const resized = fakeBitmap();
    const cpuBacked = fakeBitmap();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValueOnce(resized.bitmap).mockResolvedValueOnce(cpuBacked.bitmap),
    );
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);

    const converted = await toModelInputBitmap(fakeFrame().frame, 64, 'cpu');

    expect(converted.bitmap).toBe(cpuBacked.bitmap);
    expect(resized.close).toHaveBeenCalled();
    expect(converted).toMatchObject({ originalWidth: 1280, originalHeight: 720 });
  });
});

describe('lookaheadDecoder', () => {
  const probedHardwareAcceleration = async (inferenceSite: InferenceSite) => {
    const isConfigSupported = vi.fn((_config: VideoDecoderConfig) => Promise.resolve({ supported: false }));
    vi.stubGlobal('VideoDecoder', Object.assign(vi.fn(), { isConfigSupported }));
    const job = { config: { codec: 'vp8' }, packets: [], targets: [] };
    await expect(lookaheadDecoder(64, inferenceSite).decode(job)[Symbol.asyncIterator]().next()).rejects.toThrow(
      'Unsupported codec vp8',
    );
    return isConfigSupported.mock.calls[0]?.[0].hardwareAcceleration;
  };

  it('lets the decoder pick hardware when frames are inferred in the service worker', async () => {
    expect(await probedHardwareAcceleration('service-worker')).toBe('no-preference');
  });

  it('asks for a software decoder when frames are inferred in the host page', async () => {
    expect(await probedHardwareAcceleration('host-page')).toBe('prefer-software');
  });
});
