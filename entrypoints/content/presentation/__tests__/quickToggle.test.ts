import { describe, expect, it } from 'vitest';

import { clipContentRectToBox } from '@/entrypoints/content/presentation/imageLayout';
import { eyeButtonOffsetInParent } from '@/entrypoints/content/presentation/quickToggle';

const BUTTON_SIZE = 32;
const MARGIN = 8;

describe('eye button placement', () => {
  it('sits at the top-right of the picture for a plain feed image', () => {
    const offset = eyeButtonOffsetInParent(
      { top: 50, left: 100 },
      { offsetX: 0, offsetY: 0, width: 400, height: 300 },
      BUTTON_SIZE,
      MARGIN,
    );

    expect(offset).toEqual({ top: 58, left: 460 });
  });

  it('lands on the visible picture, not the element box, for a letterboxed lightbox image', () => {
    // picture centered at x=200 width 600: corner at 760, not the element box's 960
    const offset = eyeButtonOffsetInParent(
      { top: 0, left: 0 },
      { offsetX: 200, offsetY: 50, width: 600, height: 400 },
      BUTTON_SIZE,
      MARGIN,
    );

    expect(offset).toEqual({ top: 58, left: 760 });
  });

  it('stays inside the element box for a cover-cropped gallery image', () => {
    // 400x300 landscape rendered cover into a 300x300 grid cell: the unclipped content
    // rect overflows 50px per side and would push the button past the visible right edge
    const contentRect = clipContentRectToBox({ offsetX: -50, offsetY: 0, width: 400, height: 300 }, 300, 300);
    const offset = eyeButtonOffsetInParent({ top: 0, left: 0 }, contentRect, BUTTON_SIZE, MARGIN);

    expect(offset).toEqual({ top: 8, left: 260 });
  });

  it('never leaves the picture on the left when the content is narrower than the button', () => {
    const offset = eyeButtonOffsetInParent(
      { top: 10, left: 300 },
      { offsetX: 40, offsetY: 0, width: 20, height: 200 },
      BUTTON_SIZE,
      MARGIN,
    );

    expect(offset.left).toBe(340);
  });
});
