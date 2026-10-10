import { describe, expect, it } from 'vitest';

import { chooseTap } from '@/entrypoints/content/video/tap/tapChoice';

describe('Bitstream Tap choice', () => {
  it('taps an MSE Source through its blob URL', () => {
    expect(chooseTap({ srcObject: null, url: 'blob:https://youtube.com/1' })).toEqual({
      kind: 'mse',
      objectUrl: 'blob:https://youtube.com/1',
    });
  });

  it('taps a Progressive Source through a range fetch', () => {
    expect(chooseTap({ srcObject: null, url: 'https://cdn.test/a.mp4' })).toEqual({
      kind: 'progressive',
      url: 'https://cdn.test/a.mp4',
    });
  });

  it('has no tap for object-backed streams, native HLS or non-network URLs', () => {
    expect(chooseTap({ srcObject: {} as MediaStream, url: '' })).toBeNull();
    expect(chooseTap({ srcObject: null, url: 'https://cdn.test/live/index.m3u8?token=1' })).toBeNull();
    expect(chooseTap({ srcObject: null, url: 'data:video/mp4;base64,AAAA' })).toBeNull();
  });
});
