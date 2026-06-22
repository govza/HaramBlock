import { describe, expect, it } from 'vitest';

import { edgeBoundingBoxCorrection } from '@/entrypoints/background/modelUtils/corrections';

import type { IElementPrediction } from '@/utils/types';

function prediction(box: { x: number; y: number; width: number; height: number }): IElementPrediction {
  return {
    classId: 0,
    className: 'person',
    probability: 0.9,
    boundingBox: box,
    masks: { width: 0, height: 0, startValue: 0, runs: [] },
  };
}

function correctOne(
  box: { x: number; y: number; width: number; height: number },
  imageWidth: number,
  imageHeight: number,
  options?: { edgeThreshold?: number },
) {
  return edgeBoundingBoxCorrection([prediction(box)], imageWidth, imageHeight, options)[0]?.boundingBox;
}

describe('edgeBoundingBoxCorrection', () => {
  it('snaps a near-full box out to every edge (default 10% threshold)', () => {
    // Image 1000x1000 -> edge band = 100px. All four sides fall inside the band.
    const result = correctOne({ x: 50, y: 50, width: 900, height: 900 }, 1000, 1000);
    expect(result).toEqual({ x: 0, y: 0, width: 1000, height: 1000 });
  });

  it('leaves a centered box untouched', () => {
    const box = { x: 400, y: 400, width: 200, height: 200 };
    expect(correctOne(box, 1000, 1000)).toEqual(box);
  });

  it('snaps the top-left corner when x and y sit exactly on the threshold', () => {
    // x = y = 100 = edge band, and `<=` snaps it to 0, which grows width/height.
    const result = correctOne({ x: 100, y: 100, width: 200, height: 200 }, 1000, 1000);
    expect(result).toEqual({ x: 0, y: 0, width: 300, height: 300 });
  });

  it('snaps the right edge when it sits exactly on the far boundary', () => {
    // right = 900 = imageWidth - edgeBand, and `>=` snaps it out to imageWidth.
    const result = correctOne({ x: 500, y: 500, width: 400, height: 100 }, 1000, 1000);
    expect(result).toEqual({ x: 500, y: 500, width: 500, height: 100 });
  });

  it('respects a custom edgeThreshold', () => {
    // With a 2% band (20px) a box starting at x=25 is no longer in the edge zone.
    const box = { x: 25, y: 25, width: 200, height: 200 };
    expect(correctOne(box, 1000, 1000, { edgeThreshold: 0.02 })).toEqual(box);
    // ...whereas the default 10% band snaps it to the origin.
    expect(correctOne(box, 1000, 1000)).toEqual({ x: 0, y: 0, width: 225, height: 225 });
  });

  it('with a zero threshold only snaps boxes already touching an edge', () => {
    const interior = { x: 10, y: 10, width: 980, height: 980 };
    expect(correctOne(interior, 1000, 1000, { edgeThreshold: 0 })).toEqual(interior);

    const touching = { x: 0, y: 0, width: 1000, height: 1000 };
    expect(correctOne(touching, 1000, 1000, { edgeThreshold: 0 })).toEqual(touching);
  });

  it('uses separate horizontal and vertical bands for non-square images', () => {
    // 2000x500 -> bands of 200px (x) and 50px (y). Only the top edge (y=40) is within its band.
    const result = correctOne({ x: 300, y: 40, width: 400, height: 200 }, 2000, 500);
    expect(result).toEqual({ x: 300, y: 0, width: 400, height: 240 });
  });

  it('corrects every prediction and preserves their other fields and order', () => {
    const predictions: IElementPrediction[] = [
      { ...prediction({ x: 10, y: 10, width: 200, height: 200 }), className: 'a', classId: 1, probability: 0.7 },
      { ...prediction({ x: 400, y: 400, width: 100, height: 100 }), className: 'b', classId: 2, probability: 0.8 },
    ];

    const corrected = edgeBoundingBoxCorrection(predictions, 1000, 1000);

    expect(corrected).toHaveLength(2);
    expect(corrected[0]).toMatchObject({ className: 'a', classId: 1, probability: 0.7 });
    expect(corrected[0]?.boundingBox).toEqual({ x: 0, y: 0, width: 210, height: 210 });
    expect(corrected[1]).toMatchObject({ className: 'b', classId: 2, probability: 0.8 });
    expect(corrected[1]?.boundingBox).toEqual({ x: 400, y: 400, width: 100, height: 100 });
  });

  it('does not mutate the input predictions', () => {
    const original = prediction({ x: 10, y: 10, width: 900, height: 900 });
    const snapshot = structuredClone(original);

    edgeBoundingBoxCorrection([original], 1000, 1000);

    expect(original).toEqual(snapshot);
  });
});
