import { describe, expect, it } from 'vitest';

import { clipContentRectToBox } from '@/entrypoints/content/presentation/imageLayout';

describe('clipContentRectToBox', () => {
  it('clips cover-fit crop overflow back to the element box', () => {
    // 400x300 landscape rendered cover into a 300x300 square: content overflows 50px per side
    const clipped = clipContentRectToBox({ offsetX: -50, offsetY: 0, width: 400, height: 300 }, 300, 300);

    expect(clipped).toEqual({ offsetX: 0, offsetY: 0, width: 300, height: 300 });
  });

  it('keeps a contain-fit rect that already lies inside the box', () => {
    const contained = { offsetX: 200, offsetY: 50, width: 600, height: 400 };

    expect(clipContentRectToBox(contained, 1000, 500)).toEqual(contained);
  });

  it('collapses to zero size instead of going negative when there is no overlap', () => {
    const clipped = clipContentRectToBox({ offsetX: 500, offsetY: 400, width: 100, height: 100 }, 300, 300);

    expect(clipped.width).toBe(0);
    expect(clipped.height).toBe(0);
  });
});
