import { WASM_SESSION_MAX_BYTES, WEBGPU_SESSION_MAX_BYTES } from '@/entrypoints/content/video/dvr/ringBudget';
import { logger } from '@/utils/logger';

import type { ModelService } from '@/entrypoints/background/services/modelService';

/**
 * Relay Fetch (CONTEXT.md): fetches a media URL on behalf of the content
 * script — host permissions exempt the background from CORS, so the bytes
 * decode origin-clean via a blob: clone. Stateless: only in-flight dedup
 * (HTTP cache and the content-side clone cache cover repeats); the byte cap
 * reuses the DVR per-session budget tiers.
 */
export class MediaFetchService {
  private readonly inflight = new Map<string, Promise<ArrayBuffer | null>>();

  constructor(private modelService: ModelService) {}

  /** Resolves to null on any failure (not ok, over budget, network error): the caller fails open. */
  fetchMediaBytes(url: string): Promise<ArrayBuffer | null> {
    const pending = this.inflight.get(url);
    if (pending) return pending;

    const request = this.fetchWithinBudget(url)
      .catch((error: unknown) => {
        logger.withTag('mediaFetch').debug('Relay Fetch failed:', url, error);
        return null;
      })
      .finally(() => this.inflight.delete(url));
    this.inflight.set(url, request);
    return request;
  }

  private maxBytes(): number {
    return this.modelService.getInferenceBackend() === 'webgpu' ? WEBGPU_SESSION_MAX_BYTES : WASM_SESSION_MAX_BYTES;
  }

  private async fetchWithinBudget(url: string): Promise<ArrayBuffer | null> {
    const cap = this.maxBytes();
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok || !response.body) {
      logger.withTag('mediaFetch').debug('Relay Fetch rejected:', url, response.status);
      return null;
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (declaredLength > cap) {
      logger.withTag('mediaFetch').debug('Relay Fetch over budget:', url, declaredLength, '>', cap);
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
        logger.withTag('mediaFetch').debug('Relay Fetch aborted mid-stream over budget:', url, total, '>', cap);
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
  }
}
