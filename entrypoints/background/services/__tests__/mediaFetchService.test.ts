import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MEDIA_DOWNLOAD_MAX_BYTES,
  MEDIA_FETCH_TIMEOUT_MS,
  MediaFetchService,
} from '@/entrypoints/background/services/mediaFetchService';

const streamOf = (chunks: Uint8Array[]) => {
  let index = 0;
  const cancel = vi.fn(() => Promise.resolve());
  return {
    cancel,
    getReader: () => ({
      read: () =>
        index < chunks.length
          ? Promise.resolve({ done: false, value: chunks[index++] })
          : Promise.resolve({ done: true, value: undefined }),
      cancel,
    }),
  };
};

const okResponse = (body: ReturnType<typeof streamOf>, contentLength?: number) => ({
  ok: true,
  status: 200,
  headers: { get: (name: string) => (name === 'content-length' && contentLength ? String(contentLength) : null) },
  body,
});

describe('MediaFetchService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns the concatenated bytes for an in-cap download', async () => {
    const body = streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(okResponse(body))),
    );

    const bytes = await new MediaFetchService().fetchMediaBytes('https://cdn/x.mp4');
    expect(new Uint8Array(bytes!)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('rejects a declared over-cap download before reading the body', async () => {
    const body = streamOf([]);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(okResponse(body, MEDIA_DOWNLOAD_MAX_BYTES + 1))),
    );

    await expect(new MediaFetchService().fetchMediaBytes('https://cdn/big.mp4')).resolves.toBeNull();
    expect(body.cancel).toHaveBeenCalled();
  });

  it('aborts mid-stream when the running total crosses the cap', async () => {
    const half = new Uint8Array(Math.ceil(MEDIA_DOWNLOAD_MAX_BYTES / 2) + 1);
    const body = streamOf([half, half]);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(okResponse(body))),
    );

    await expect(new MediaFetchService().fetchMediaBytes('https://cdn/big.mp4')).resolves.toBeNull();
    expect(body.cancel).toHaveBeenCalled();
  });

  it('aborts a stalled fetch at the timeout instead of hanging the caller', async () => {
    const fetchMock = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const pending = new MediaFetchService().fetchMediaBytes('https://cdn/stall.mp4');
    await vi.advanceTimersByTimeAsync(MEDIA_FETCH_TIMEOUT_MS + 1);
    await expect(pending).resolves.toBeNull();
  });

  it('dedupes concurrent requests for the same URL', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse(streamOf([new Uint8Array([9])]))));
    vi.stubGlobal('fetch', fetchMock);

    const service = new MediaFetchService();
    const [a, b] = await Promise.all([
      service.fetchMediaBytes('https://cdn/x.mp4'),
      service.fetchMediaBytes('https://cdn/x.mp4'),
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(a).toBe(b);
  });
});
