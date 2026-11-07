// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { applyWholeBlur, clearWholeBlur } from '@/entrypoints/content/video/session/wholeBlur';
import { DEFAULT_HOST_SETTINGS } from '@/utils/constants';

describe('whole blur', () => {
  it('clears fully after the page rewrites className between two applies', () => {
    const video = document.createElement('video');
    applyWholeBlur(video, DEFAULT_HOST_SETTINGS);
    video.className = 'video-stream html5-main-video';
    applyWholeBlur(video, DEFAULT_HOST_SETTINGS);
    clearWholeBlur(video);
    expect(video.style.getPropertyValue('filter')).toBe('');
  });

  it('restores the page filter', () => {
    const video = document.createElement('video');
    video.style.filter = 'contrast(1.1)';
    applyWholeBlur(video, DEFAULT_HOST_SETTINGS);
    clearWholeBlur(video);
    expect(video.style.getPropertyValue('filter')).toBe('contrast(1.1)');
  });

  it('leaves a page filter alone when never blurred', () => {
    const video = document.createElement('video');
    video.style.filter = 'contrast(1.1)';
    clearWholeBlur(video);
    expect(video.style.getPropertyValue('filter')).toBe('contrast(1.1)');
  });
});
