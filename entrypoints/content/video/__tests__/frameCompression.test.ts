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
    const { bitmapToCompressedBlob } = await import('@/entrypoints/content/video/frameCompression');

    const first = await bitmapToCompressedBlob(fakeBitmap(640, 360));
    await bitmapToCompressedBlob(fakeBitmap(640, 360));
    const resized = await bitmapToCompressedBlob(fakeBitmap(320, 180));

    expect(FakeOffscreenCanvas.constructed).toBe(1);
    expect(first.size).toBe(640 * 360);
    expect(resized.size).toBe(320 * 180);
  });
});
