// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import { MaskCoverage, paintPixelatedMask } from '@/entrypoints/content/presentation/maskCoverage';

import type { IRLEMask } from '@/utils/rle';
import type { IElementPrediction, IMaskingSettings, IMaskTransform } from '@/utils/types';

const IDENTITY: IMaskTransform = { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
const CONTENT = { offsetX: 10, offsetY: 0, width: 100, height: 100 };

const predictionWith = (masks: IRLEMask): IElementPrediction => ({
  classId: 0,
  className: 'unsafe',
  probability: 0.9,
  boundingBox: { x: 0, y: 0, width: 2, height: 2 },
  masks,
});

const coverageOf = (...masks: IRLEMask[]) => MaskCoverage.from(masks.map(predictionWith), IDENTITY, 2, 2);

describe('MaskCoverage.from', () => {
  it('is null when no prediction carries a mask', () => {
    expect(coverageOf({ width: 2, height: 2, startValue: 0, runs: [] })).toBeNull();
  });

  it('is null for a zero-sized grid', () => {
    expect(coverageOf({ width: 0, height: 0, startValue: 1, runs: [1] })).toBeNull();
  });

  it('covers nothing when every cell is clear', () => {
    expect(coverageOf({ width: 2, height: 2, startValue: 0, runs: [4] })?.rects(CONTENT)).toEqual([]);
  });

  it('ignores masks whose grid size differs from the first', () => {
    const coverage = coverageOf(
      { width: 2, height: 2, startValue: 1, runs: [1, 3] },
      { width: 1, height: 1, startValue: 1, runs: [1] },
    );
    expect(coverage?.rects(CONTENT)).toEqual([{ left: 10, top: 0, right: 60, bottom: 50 }]);
  });
});

describe('MaskCoverage.rects', () => {
  it('maps a covered cell onto the content rectangle', () => {
    expect(coverageOf({ width: 2, height: 2, startValue: 1, runs: [1, 3] })?.rects(CONTENT)).toEqual([
      { left: 10, top: 0, right: 60, bottom: 50 },
    ]);
  });

  it('merges a covered column spanning rows into one rectangle', () => {
    expect(coverageOf({ width: 2, height: 2, startValue: 0, runs: [1, 1, 1, 1] })?.rects(CONTENT)).toEqual([
      { left: 60, top: 0, right: 110, bottom: 100 },
    ]);
  });

  it('unions masks so overlapping cells are covered once', () => {
    const coverage = coverageOf(
      { width: 2, height: 2, startValue: 1, runs: [1, 3] },
      { width: 2, height: 2, startValue: 1, runs: [2, 2] },
    );
    expect(coverage?.rects(CONTENT)).toEqual([{ left: 10, top: 0, right: 110, bottom: 50 }]);
  });

  it('stretches only the letterbox-free grid window onto the content', () => {
    const letterboxed = MaskCoverage.from(
      [predictionWith({ width: 4, height: 2, startValue: 0, runs: [1, 2, 5] })],
      { scaleX: 10, scaleY: 10, offsetX: 1, offsetY: 0 },
      20,
      20,
    );
    expect(letterboxed?.rects({ offsetX: 0, offsetY: 0, width: 200, height: 200 })).toEqual([
      { left: 0, top: 0, right: 200, bottom: 100 },
    ]);
  });
});

interface RecordedContext {
  canvas: { width: number; height: number; style: { filter: string } };
  calls: unknown[][];
}

const recordingContext = (canvas: RecordedContext['canvas']): RecordedContext & Record<string, unknown> => {
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      calls.push([name, ...args]);
  const ctx: RecordedContext & Record<string, unknown> = {
    canvas,
    calls,
    clearRect: record('clearRect'),
    fillRect: record('fillRect'),
    drawImage: record('drawImage'),
  };
  for (const property of ['imageSmoothingEnabled', 'globalCompositeOperation', 'fillStyle']) {
    Object.defineProperty(ctx, property, {
      set: (value: unknown) => {
        calls.push([property, value]);
      },
    });
  }
  return ctx;
};

describe('paintPixelatedMask', () => {
  const masking = { pixelationScale: 0.5 } as IMaskingSettings;

  it('pixelates the source into the content rect and keeps it only where covered', () => {
    const scratch: RecordedContext[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement): never {
      const ctx = recordingContext(this);
      scratch.push(ctx);
      return ctx as never;
    });
    const target = recordingContext({ width: 120, height: 100, style: { filter: '' } });
    const source = { width: 8, height: 8 } as unknown as CanvasImageSource;
    const coverage = coverageOf({ width: 2, height: 2, startValue: 0, runs: [1, 1, 1, 1] });
    if (!coverage) throw new Error('expected coverage');

    paintPixelatedMask(target as unknown as CanvasRenderingContext2D, source, coverage, CONTENT, masking);

    const [downscaled, alpha, grid] = scratch;
    expect(downscaled?.calls).toContainEqual([
      'drawImage',
      source,
      0,
      0,
      downscaled?.canvas.width,
      downscaled?.canvas.height,
    ]);
    expect(grid?.calls).toEqual([
      ['fillStyle', 'rgba(0,0,0,1)'],
      ['fillRect', 1, 0, 1, 2],
    ]);
    expect(alpha?.calls).toEqual([
      ['imageSmoothingEnabled', false],
      ['drawImage', grid?.canvas, 0, 0, 2, 2, 10, 0, 100, 100],
    ]);
    expect(alpha?.canvas).toMatchObject({ width: 120, height: 100 });
    expect(target.calls).toEqual([
      ['imageSmoothingEnabled', false],
      ['clearRect', 0, 0, 120, 100],
      ['drawImage', downscaled?.canvas, 10, 0, 100, 100],
      ['globalCompositeOperation', 'destination-in'],
      ['drawImage', alpha?.canvas, 0, 0],
      ['globalCompositeOperation', 'source-over'],
    ]);
  });

  it('paints nothing into an empty content rectangle', () => {
    const target = recordingContext({ width: 120, height: 100, style: { filter: '' } });
    const coverage = coverageOf({ width: 2, height: 2, startValue: 1, runs: [4] });
    if (!coverage) throw new Error('expected coverage');

    paintPixelatedMask(
      target as unknown as CanvasRenderingContext2D,
      {} as CanvasImageSource,
      coverage,
      { ...CONTENT, width: 0 },
      masking,
    );

    expect(target.calls).toEqual([]);
  });
});
