import { describe, expect, it } from 'vitest';

import { createRangeFetchSource } from '@/utils/lookahead/rangeFetchSource';

const FILE = Uint8Array.from({ length: 300 }, (_, index) => index % 256);

function rangeServer(options: { status?: number; contentType?: string } = {}) {
  const requests: { range: string | null; init: RequestInit | undefined }[] = [];
  const fetchFn = (_url: string | URL | Request, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('Range');
    requests.push({ range, init });
    const [, from, to] = /bytes=(\d+)-(\d+)/.exec(range ?? '') ?? [];
    const start = Number(from);
    const end = Math.min(Number(to), FILE.length - 1);
    const status = options.status ?? 206;
    return Promise.resolve(
      new Response(status === 206 ? FILE.slice(start, end + 1) : 'denied', {
        status,
        headers: {
          'Content-Type': options.contentType ?? 'video/mp4',
          'Content-Range': `bytes ${start}-${end}/${FILE.length}`,
        },
      }),
    );
  };
  return { fetchFn, requests };
}

describe('Progressive range fetch', () => {
  it('learns the size from the first block request, without a separate probe', async () => {
    const server = rangeServer();
    const source = createRangeFetchSource('https://media.test/v.mp4', { fetchFn: server.fetchFn, blockSize: 64 });

    expect(await source.size()).toBe(300);
    expect(await source.read(10, 20)).toEqual(FILE.slice(10, 20));
    expect(server.requests.map(request => request.range)).toEqual(['bytes=0-63']);
  });

  it('reads whole blocks ahead and serves later reads from them', async () => {
    const server = rangeServer();
    const source = createRangeFetchSource('https://media.test/v.mp4', { fetchFn: server.fetchFn, blockSize: 64 });
    await source.size();

    expect(await source.read(100, 200)).toEqual(FILE.slice(100, 200));
    expect(await source.read(150, 160)).toEqual(FILE.slice(150, 160));
    expect(server.requests.map(request => request.range)).toEqual(['bytes=0-63', 'bytes=64-255']);
  });

  it('fetches without cookies or a Referer', async () => {
    const server = rangeServer();
    await createRangeFetchSource('https://media.test/v.mp4', { fetchFn: server.fetchFn, blockSize: 64 }).size();

    expect(server.requests[0]?.init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
  });

  it.each([
    ['a full-body 200', { status: 200 }],
    ['a 403', { status: 403 }],
    ['a 401', { status: 401 }],
    ['a non-media body', { contentType: 'text/html' }],
  ])('treats %s on the first request as unreachable', async (_label, options) => {
    const server = rangeServer(options);
    const source = createRangeFetchSource('https://media.test/v.mp4', { fetchFn: server.fetchFn, blockSize: 64 });

    await expect(source.size()).rejects.toThrow();
  });

  it.each([
    ['a full-body 200', { status: 200 }],
    ['a non-media body', { status: 206, headers: { 'Content-Type': 'text/html' } }],
    ['a body without a total size', { status: 206, headers: { 'Content-Type': 'video/mp4' } }],
  ])('cancels the body of %s first response instead of downloading it', async (_label, init) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
    });
    const fetchFn = () => Promise.resolve(new Response(body, init));
    const source = createRangeFetchSource('https://media.test/v.mp4', { fetchFn, blockSize: 64 });

    await expect(source.size()).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
});
