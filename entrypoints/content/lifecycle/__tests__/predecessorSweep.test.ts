import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sweepPredecessorArtifacts } from '@/entrypoints/content/lifecycle/predecessorSweep';
import { GIF_MASK_OVERLAY_ATTR } from '@/entrypoints/content/presentation/constants';
import { SESSION_ID_ATTR } from '@/entrypoints/content/video/session/markers';

class FakeStyle {
  private readonly properties = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.properties.set(name, value);
  }

  removeProperty(name: string): void {
    this.properties.delete(name);
  }

  getPropertyValue(name: string): string {
    return this.properties.get(name) ?? '';
  }
}

class FakeOverlay {
  removed = false;
  previousElementSibling: FakeImage | null = null;

  constructor(private readonly attributes: string[] = []) {}

  hasAttribute(name: string): boolean {
    return this.attributes.includes(name);
  }

  remove(): void {
    this.removed = true;
  }
}

class FakeImage {
  style = new FakeStyle();
}

class FakeVideo {
  style = new FakeStyle();
}

/**
 * The fake resolves the exact selectors the sweep must use — built from the
 * same marker constants the producing modules stamp — so a drifted selector
 * matches nothing and the test fails instead of silently passing.
 */
function stubDocument(overlays: FakeOverlay[], videos: FakeVideo[]): { queried: string[] } {
  const queried: string[] = [];
  vi.stubGlobal('document', {
    querySelectorAll: (selector: string) => {
      queried.push(selector);
      if (selector === `video[${SESSION_ID_ATTR}]`) return videos;
      if (selector.startsWith('[') && selector.includes(`[${GIF_MASK_OVERLAY_ATTR}]`)) return overlays;
      return [];
    },
  });
  return { queried };
}

describe('sweepPredecessorArtifacts', () => {
  beforeEach(() => {
    stubDocument([], []);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('removes every predecessor overlay', () => {
    const overlays = [new FakeOverlay(), new FakeOverlay()];
    stubDocument(overlays, []);

    sweepPredecessorArtifacts();

    expect(overlays.every(overlay => overlay.removed)).toBe(true);
  });

  it('selects videos by the session marker the registry stamps', () => {
    const { queried } = stubDocument([], []);

    sweepPredecessorArtifacts();

    expect(queried).toContain(`video[${SESSION_ID_ATTR}]`);
  });

  it('lifts the DVR-hidden opacity from a predecessor video', () => {
    const video = new FakeVideo();
    video.style.setProperty('opacity', '0');
    stubDocument([], [video]);

    sweepPredecessorArtifacts();

    expect(video.style.getPropertyValue('opacity')).toBe('');
  });

  it('leaves inline opacity alone when the predecessor never hid the video', () => {
    const video = new FakeVideo();
    video.style.setProperty('opacity', '0.5');
    stubDocument([], [video]);

    sweepPredecessorArtifacts();

    expect(video.style.getPropertyValue('opacity')).toBe('0.5');
  });

  it('unhides the image a GIF-player overlay was covering', () => {
    const image = new FakeImage();
    image.style.setProperty('opacity', '0');
    const gifOverlay = new FakeOverlay([GIF_MASK_OVERLAY_ATTR]);
    gifOverlay.previousElementSibling = image;
    stubDocument([gifOverlay], []);

    sweepPredecessorArtifacts();

    expect(gifOverlay.removed).toBe(true);
    expect(image.style.getPropertyValue('opacity')).toBe('');
  });

  it('leaves siblings of non-GIF overlays untouched', () => {
    const image = new FakeImage();
    image.style.setProperty('opacity', '0');
    const dvrOverlay = new FakeOverlay();
    dvrOverlay.previousElementSibling = image;
    stubDocument([dvrOverlay], []);

    sweepPredecessorArtifacts();

    expect(dvrOverlay.removed).toBe(true);
    expect(image.style.getPropertyValue('opacity')).toBe('0');
  });
});
