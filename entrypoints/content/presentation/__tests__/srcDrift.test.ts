import { beforeEach, describe, expect, it, vi } from 'vitest';

import { notifySrcDrift, setSrcDriftHandler } from '@/entrypoints/content/presentation/srcDrift';

const fakeImage = (): HTMLImageElement => ({}) as HTMLImageElement;

describe('srcDrift', () => {
  beforeEach(() => {
    setSrcDriftHandler(null);
  });

  it('invokes the registered handler with the drifted image', () => {
    const handler = vi.fn();
    setSrcDriftHandler(handler);
    const img = fakeImage();

    notifySrcDrift(img);

    expect(handler).toHaveBeenCalledExactlyOnceWith(img);
  });

  it('is a no-op without a handler', () => {
    expect(() => notifySrcDrift(fakeImage())).not.toThrow();
  });

  it('stops notifying after the handler is cleared', () => {
    const handler = vi.fn();
    setSrcDriftHandler(handler);
    setSrcDriftHandler(null);

    notifySrcDrift(fakeImage());

    expect(handler).not.toHaveBeenCalled();
  });
});
