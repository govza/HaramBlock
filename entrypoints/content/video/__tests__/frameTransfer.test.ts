import { describe, expect, it } from 'vitest';

import { isWriteOnlyCanvasError } from '@/entrypoints/content/video/frameTransfer';

describe('isWriteOnlyCanvasError', () => {
  it('recognizes Firefox write-only canvas blob failures', () => {
    expect(
      isWriteOnlyCanvasError(
        new DOMException('OffscreenCanvas.convertToBlob: Cannot get blob from write-only canvas.'),
      ),
    ).toBe(true);
  });

  it('does not classify unrelated transport failures as permanent', () => {
    expect(isWriteOnlyCanvasError(new Error('Provider unavailable'))).toBe(false);
  });
});
