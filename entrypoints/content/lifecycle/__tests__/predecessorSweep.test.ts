import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sweepPredecessorArtifacts } from '@/entrypoints/content/lifecycle/predecessorSweep';

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

  remove(): void {
    this.removed = true;
  }
}

class FakeVideo {
  style = new FakeStyle();
}

function stubDocument(overlays: FakeOverlay[], videos: FakeVideo[]): void {
  vi.stubGlobal('document', {
    querySelectorAll: (selector: string) => (selector.startsWith('video') ? videos : overlays),
  });
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
});
