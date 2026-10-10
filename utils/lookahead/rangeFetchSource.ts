import type { ByteRangeSource } from '@/utils/lookahead/ports';

export const RANGE_BLOCK_BYTES = 64 * 1024;
const MAX_CACHED_BLOCKS = 256;
const MEDIA_CONTENT_TYPE = /^(video|audio)\/|^application\/(octet-stream|mp4)/i;

export class RangeFetchRejectedError extends Error {
  override readonly name = 'RangeFetchRejectedError';
}

interface RangeFetchOptions {
  fetchFn?: typeof fetch;
  blockSize?: number;
}

function totalSizeOf(response: Response): number | null {
  const match = /\/(\d+)\s*$/.exec(response.headers.get('Content-Range') ?? '');
  return match ? Number(match[1]) : null;
}

function isMediaBody(response: Response): boolean {
  const type = response.headers.get('Content-Type');
  return !type || MEDIA_CONTENT_TYPE.test(type);
}

export function createRangeFetchSource(url: string, options: RangeFetchOptions = {}): ByteRangeSource {
  const fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  const blockSize = options.blockSize ?? RANGE_BLOCK_BYTES;
  const blocks = new Map<number, Uint8Array>();
  let sizeBytes: Promise<number> | null = null;

  const request = async (firstBlock: number, lastBlock: number, size: number | null): Promise<Response> => {
    const start = firstBlock * blockSize;
    const end = Math.min((lastBlock + 1) * blockSize, size ?? Number.MAX_SAFE_INTEGER) - 1;
    return fetchFn(url, {
      headers: { Range: `bytes=${start}-${end}` },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
  };

  const storeBlocks = (firstBlock: number, bytes: Uint8Array) => {
    for (let offset = 0, block = firstBlock; offset < bytes.length; offset += blockSize, block++) {
      blocks.delete(block);
      blocks.set(block, bytes.slice(offset, offset + blockSize));
    }
    while (blocks.size > MAX_CACHED_BLOCKS) {
      const oldest = blocks.keys().next().value;
      if (oldest === undefined) break;
      blocks.delete(oldest);
    }
  };

  const fetchBlocks = async (firstBlock: number, lastBlock: number, size: number): Promise<void> => {
    const response = await request(firstBlock, lastBlock, size);
    if (response.status !== 206) throw new RangeFetchRejectedError(`Range request answered ${response.status}`);
    storeBlocks(firstBlock, new Uint8Array(await response.arrayBuffer()));
  };

  const probe = async (): Promise<number> => {
    const response = await request(0, 0, null);
    if (response.status !== 206) throw new RangeFetchRejectedError(`First range request answered ${response.status}`);
    if (!isMediaBody(response)) throw new RangeFetchRejectedError('First range request returned a non-media body');
    const total = totalSizeOf(response);
    if (total === null) throw new RangeFetchRejectedError('First range request has no total size');
    storeBlocks(0, new Uint8Array(await response.arrayBuffer()));
    return total;
  };

  return {
    size() {
      sizeBytes ??= probe();
      return sizeBytes;
    },
    async read(start, end) {
      const size = await this.size();
      const firstBlock = Math.floor(start / blockSize);
      const lastBlock = Math.floor((end - 1) / blockSize);
      let missingFrom: number | null = null;
      for (let block = firstBlock; block <= lastBlock + 1; block++) {
        const missing = block <= lastBlock && !blocks.has(block);
        if (missing && missingFrom === null) missingFrom = block;
        if (!missing && missingFrom !== null) {
          await fetchBlocks(missingFrom, block - 1, size);
          missingFrom = null;
        }
      }
      const out = new Uint8Array(end - start);
      for (let block = firstBlock; block <= lastBlock; block++) {
        const bytes = blocks.get(block);
        if (!bytes) throw new RangeFetchRejectedError('Range block missing after fetch');
        const blockStart = block * blockSize;
        const from = Math.max(start, blockStart);
        const to = Math.min(end, blockStart + bytes.length);
        out.set(bytes.subarray(from - blockStart, to - blockStart), from - start);
      }
      return out;
    },
  };
}
