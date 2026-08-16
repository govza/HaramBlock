import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSrcDriftHandler, notifySrcDrift, setSrcDriftHandler } from '@/entrypoints/content/presentation/srcDrift';

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

  it('does not clear a successor handler', () => {
    const old = vi.fn();
    const successor = vi.fn();
    setSrcDriftHandler(old);
    setSrcDriftHandler(successor);
    clearSrcDriftHandler(old);

    const img = fakeImage();
    notifySrcDrift(img);

    expect(successor).toHaveBeenCalledExactlyOnceWith(img);
  });

  it('clears its own registered handler', () => {
    const handler = vi.fn();
    setSrcDriftHandler(handler);
    clearSrcDriftHandler(handler);

    notifySrcDrift(fakeImage());

    expect(handler).not.toHaveBeenCalled();
  });

  it('stops notifying after the handler is cleared', () => {
    const handler = vi.fn();
    setSrcDriftHandler(handler);
    setSrcDriftHandler(null);

    notifySrcDrift(fakeImage());

    expect(handler).not.toHaveBeenCalled();
  });
});
