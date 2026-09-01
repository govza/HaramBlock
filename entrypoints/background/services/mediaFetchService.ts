import { getLogger } from '@/utils/telemetry';

const log = getLogger('mediaFetch');

/** Dedicated media-download cap, decoupled from the DVR ring budget (ADR 0002). */
export const MEDIA_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
/** Whole-download bound: a stalled CDN must not hang the caller's samplers. */
export const MEDIA_FETCH_TIMEOUT_MS = 30_000;

/**
 * Relay Fetch (CONTEXT.md): fetches a media URL on behalf of the content
 * script — host permissions exempt the background from CORS, so the bytes
 * decode origin-clean via a blob: clone. Stateless: only in-flight dedup
 * (HTTP cache and the content-side clone cache cover repeats).
 */
export class MediaFetchService {
  private readonly inflight = new Map<string, Promise<ArrayBuffer | null>>();

  /** Resolves to null on any failure (not ok, over cap, timeout, network error): the caller fails open. */
  fetchMediaBytes(url: string): Promise<ArrayBuffer | null> {
    const pending = this.inflight.get(url);
    if (pending) return pending;

    const request = this.fetchWithinCap(url)
      .catch((error: unknown) => {
        log.debug('media_fetch.failed', { url, error });
        return null;
      })
      .finally(() => this.inflight.delete(url));
    this.inflight.set(url, request);
    return request;
  }

  private async fetchWithinCap(url: string): Promise<ArrayBuffer | null> {
    const cap = MEDIA_DOWNLOAD_MAX_BYTES;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MEDIA_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { credentials: 'omit', signal: controller.signal });
      if (!response.ok || !response.body) {
        log.debug('media_fetch.rejected', { url, status: response.status });
        return null;
      }

      const declaredLength = Number(response.headers.get('content-length'));
      if (declaredLength > cap) {
        log.debug('media_fetch.over_budget', { url, declaredLength, cap });
        await response.body.cancel();
        return null;
      }

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cap) {
          log.debug('media_fetch.aborted_over_budget', { url, total, cap });
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }

      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes.buffer;
    } finally {
      clearTimeout(timeout);
    }
  }
}
