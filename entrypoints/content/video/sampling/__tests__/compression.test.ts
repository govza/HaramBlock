import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeOffscreenCanvas {
  static constructed = 0;
  drawCalls: { width: number; height: number }[] = [];

  constructor(
    public width: number,
    public height: number,
  ) {
    FakeOffscreenCanvas.constructed++;
  }

  getContext(): { drawImage: (bitmap: ImageBitmap, x: number, y: number) => void } {
    return {
      drawImage: () => this.drawCalls.push({ width: this.width, height: this.height }),
    };
  }

  convertToBlob(): Promise<Blob> {
    return Promise.resolve({ size: this.width * this.height } as Blob);
  }
}

const fakeBitmap = (width: number, height: number) => ({ width, height }) as ImageBitmap;

describe('bitmapToCompressedBlob', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    FakeOffscreenCanvas.constructed = 0;
  });

  it('reuses one canvas across samples and resizes only on dimension change', async () => {
    vi.resetModules();
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    const { bitmapToCompressedBlob } = await import('@/entrypoints/content/video/sampling/compression');

    const first = await bitmapToCompressedBlob(fakeBitmap(640, 360));
    await bitmapToCompressedBlob(fakeBitmap(640, 360));
    const resized = await bitmapToCompressedBlob(fakeBitmap(320, 180));

    expect(FakeOffscreenCanvas.constructed).toBe(1);
    expect(first.size).toBe(640 * 360);
    expect(resized.size).toBe(320 * 180);
  });

  it('serializes concurrent samples so a later draw cannot repaint before the previous blob settles', async () => {
    vi.resetModules();
    let releaseFirstBlob!: () => void;
    const gate = new Promise<void>(resolve => (releaseFirstBlob = resolve));
    let convertCalls = 0;
    class GatedOffscreenCanvas extends FakeOffscreenCanvas {
      override convertToBlob(): Promise<Blob> {
        const call = ++convertCalls;
        const blob = { size: this.width * this.height } as Blob;
        return call === 1 ? gate.then(() => blob) : Promise.resolve(blob);
      }
    }
    vi.stubGlobal('OffscreenCanvas', GatedOffscreenCanvas);
    const { bitmapToCompressedBlob } = await import('@/entrypoints/content/video/sampling/compression');

    const first = bitmapToCompressedBlob(fakeBitmap(640, 360));
    const second = bitmapToCompressedBlob(fakeBitmap(320, 180));
    await Promise.resolve();
    expect(convertCalls).toBe(1);

    releaseFirstBlob();
    await expect(first).resolves.toMatchObject({ size: 640 * 360 });
    await expect(second).resolves.toMatchObject({ size: 320 * 180 });
  });
});
