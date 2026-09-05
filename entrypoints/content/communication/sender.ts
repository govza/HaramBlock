import { ROOT_CONTEXT, type Context, type Span } from '@opentelemetry/api';

import { dvrRingBudget } from '@/entrypoints/content/video/dvr/ringBudget';
import { bitmapToCompressedBlob } from '@/entrypoints/content/video/sampling/compression';
import {
  IS_CHROME,
  IMAGE_TRANSFER_KIND,
  IMAGE_FALLBACK_KIND,
  type ImageTransferKind,
  type VideoFrameTransferKind,
} from '@/utils/constants/environment';
import { backgroundRpc, waitForMessageChannel } from '@/utils/messaging/content';
import { ATTR, getLogger, getTracer, injectTraceparent } from '@/utils/telemetry';
import {
  endRoundtrip,
  endSpanWithError,
  SPAN,
  startRoundtrip,
  type UmbrellaSession,
} from '@/utils/telemetry/roundtrip';

import type { CapturedFrameSample } from '@/entrypoints/content/video/sampling/sample';
import type {
  ForcedVisibility,
  IHostSettings,
  IImagePrediction,
  IImageMetadata,
  IImageTransfer,
  IVideoFrameTransfer,
  IGifFrameTransfer,
} from '@/utils/types';

const log = getLogger('sender');
const tracer = getTracer('inference');

/**
 * Request host settings from background script
 * @param hostname - The hostname to get settings for
 * @returns Promise resolving to host settings or undefined
 */
export async function requestHostSettings(hostname: string): Promise<IHostSettings> {
  try {
    const isIncognito = browser.extension.inIncognitoContext;
    const result = await backgroundRpc.getHostSettings(hostname, isIncognito);
    if (!result) {
      throw new Error('No host settings returned from background script');
    }
    return result;
  } catch (error) {
    log.error('host_settings.request.failed', { [ATTR.hostname]: hostname, error });
    throw error;
  }
}

/**
 * Request cached predictions for a hostname from background script
 */
export async function requestCachedPredictions(hostname: string): Promise<IImagePrediction[]> {
  try {
    const result = await backgroundRpc.getCachedPredictions(hostname);
    return result || [];
  } catch (error) {
    log.error('cached_predictions.request.failed', { [ATTR.hostname]: hostname, error });
    return [];
  }
}

/**
 * Request background to update toggle state in cache
 */
export async function requestToggleUpdate(src: string, forcedVisibility: ForcedVisibility): Promise<void> {
  try {
    await backgroundRpc.updateToggleState(src, forcedVisibility);
  } catch (error) {
    log.error('toggle.update.failed', { [ATTR.src]: src, forcedVisibility, error });
  }
}

/**
 * Reset badge count for the current tab.
 * Called on new document startup to avoid stale badge values across reloads/navigation.
 */
export async function resetBadgeCount(): Promise<void> {
  try {
    await backgroundRpc.updateIconBadge(0, globalThis.location.href);
  } catch (error) {
    log.error('badge.reset.failed', { error });
  }
}

/**
 * Resolve image transfer kind with browser-specific fallback.
 * - Chrome: 'bitmap' primary, falls back to 'url'
 * - Firefox: 'blob' primary, falls back to 'url'
 */
async function resolveImageTransferKind(): Promise<ImageTransferKind> {
  // Chrome with bitmap requires MessageChannel
  if (IS_CHROME && IMAGE_TRANSFER_KIND === 'bitmap') {
    const channelReady = await waitForMessageChannel();
    if (!channelReady) {
      log.warn('transport.channel.unavailable', { fallback: IMAGE_FALLBACK_KIND });
      return IMAGE_FALLBACK_KIND;
    }
    return 'bitmap';
  }

  // Firefox or Chrome with non-bitmap: use configured kind
  return IMAGE_TRANSFER_KIND;
}

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

async function buildPayload(
  hostname: string,
  image: HTMLImageElement,
  metadata: IImageMetadata,
  priority: number,
  parent: Context,
): Promise<IImageTransfer> {
  const requestStartAt = Date.now();
  const src = image.currentSrc || image.src;
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const traceparent = injectTraceparent(parent);

  const transferKind = await resolveImageTransferKind();
  const captureSpan = tracer.startSpan(SPAN.capture, { attributes: { [ATTR.transferKind]: transferKind } }, parent);

  const fetchImageBlob = async (): Promise<{ blob: Blob; fetchTime: number }> => {
    const fetchStart = Date.now();
    const response = await fetch(src, { cache: 'force-cache' });
    if (!response.ok) {
      throw new Error(`Failed to fetch image (${response.status})`);
    }
    const blob = await response.blob();
    return { blob, fetchTime: Date.now() - fetchStart };
  };

  if (transferKind === 'bitmap') {
    try {
      const { blob, fetchTime } = await fetchImageBlob();
      const decodeStart = Date.now();
      const bitmap = await createImageBitmap(blob);
      const decodeTime = Date.now() - decodeStart;
      captureSpan.setAttributes({ [ATTR.fetchMs]: fetchTime, [ATTR.decodeMs]: decodeTime });
      captureSpan.end();
      return {
        src,
        width,
        height,
        hostname,
        metadata,
        priority,
        requestStartAt,
        fetchTime,
        decodeTime,
        kind: 'bitmap',
        bitmap,
        traceparent,
      };
    } catch (error) {
      log.warn('capture.bitmap.failed', { [ATTR.src]: src, fallback: 'url', error }, parent);
    }
  } else if (transferKind === 'blob') {
    try {
      const { blob, fetchTime } = await fetchImageBlob();
      captureSpan.setAttribute(ATTR.fetchMs, fetchTime);
      captureSpan.end();
      return {
        src,
        width,
        height,
        hostname,
        metadata,
        priority,
        requestStartAt,
        fetchTime,
        kind: 'blob',
        blob,
        traceparent,
      };
    } catch (error) {
      log.warn('capture.blob.failed', { [ATTR.src]: src, fallback: 'url', error }, parent);
    }
  }

  if (src.startsWith('blob:')) {
    endSpanWithError(captureSpan, new Error('blob URL is inaccessible from extension contexts'));
    throw new Error(`Cannot process blob URL: inaccessible from extension contexts`);
  }

  captureSpan.setAttribute(ATTR.transferKind, 'url');
  captureSpan.end();
  return { src, width, height, hostname, metadata, priority, requestStartAt, kind: 'url', traceparent };
}

/**
 * Send image for inference using comctx RPC.
 * Transfer kind is configured in environment.ts:
 * - 'bitmap': Zero-copy ImageBitmap via MessageChannel (Chrome only)
 * - 'blob': Blob via structured clone
 * - 'url': URL only, background fetches from cache
 *
 * If the configured transfer kind fails (missing MessageChannel or fetch/CORS errors), falls back to 'url'.
 * Retries on heartbeat/provider errors since the service worker may restart.
 */
async function sendImageForInference(
  hostname: string,
  image: HTMLImageElement,
  metadata: IImageMetadata,
  priority: number,
  parent: Context,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let sendSpan: Span | undefined;
    try {
      const payload = await buildPayload(hostname, image, metadata, priority, parent);
      sendSpan = tracer.startSpan(
        SPAN.send,
        { attributes: { [ATTR.transferKind]: payload.kind, attempt, [ATTR.priority]: priority } },
        parent,
      );
      await backgroundRpc.postInferenceImage(payload);
      sendSpan.end();
      return;
    } catch (error) {
      lastError = error;
      if (sendSpan) endSpanWithError(sendSpan, error);
      const isProviderError = error instanceof Error && error.message.includes('Provider unavailable');
      if (!isProviderError || attempt === MAX_RETRIES) break;
      log.warn('inference.send.retry', { attempt: attempt + 1, maxAttempts: MAX_RETRIES + 1 }, parent);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  log.error('inference.send.failed', { [ATTR.src]: image.currentSrc || image.src, error: lastError }, parent);
  throw lastError;
}

/**
 * Queue images for AI processing in background script
 * @param hostname - The hostname for these images
 * @param image - Image element to process
 * @param priority - Queue priority (higher = runs first); use the shared inference priority tiers
 * @returns Promise that resolves when images are queued
 */
export async function requestImageInference(
  hostname: string,
  image: HTMLImageElement,
  priority: number,
  parent: Context = ROOT_CONTEXT,
): Promise<void> {
  const metadata: IImageMetadata = {
    kind: 'image',
    contentType: image.dataset.contentType || null,
    contentLength: image.dataset.contentLength ? parseInt(image.dataset.contentLength) : null,
    lastModified: image.dataset.lastModified || null,
    cacheControl: image.dataset.cacheControl || null,
    etag: image.dataset.etag || null,
    expires: image.dataset.expires || null,
  };

  await sendImageForInference(hostname, image, metadata, priority, parent);
}

const BACKEND_POLL_MS = 5000;
/** Model load can take a while on cold starts; after ~2 min settle on the conservative tier. */
const BACKEND_POLL_MAX_ATTEMPTS = 24;
let backendSyncStarted = false;

/**
 * Feed the inference backend to the DVR ring budget. The backend is decided in
 * the background at model load, so it may still read 'unknown' when the page
 * initializes — poll until it resolves; until then (and on failure) the budget
 * stays at its conservative WASM tier.
 */
function syncDvrRingBudgetBackend(attempt = 0): void {
  if (attempt === 0) {
    if (backendSyncStarted) return;
    backendSyncStarted = true;
  }
  backgroundRpc
    .getInferenceBackend()
    .then(backend => {
      if (backend === 'webgpu' || backend === 'wasm') {
        dvrRingBudget.setBackend(backend);
      } else if (attempt < BACKEND_POLL_MAX_ATTEMPTS) {
        setTimeout(() => syncDvrRingBudgetBackend(attempt + 1), BACKEND_POLL_MS);
      }
    })
    .catch((error: unknown) => {
      // A transient RPC failure (service worker restarting) must not pin a
      // WebGPU machine to the conservative tier forever - keep polling.
      log.debug('backend.resolve.retry', { attempt, error });
      if (attempt < BACKEND_POLL_MAX_ATTEMPTS) {
        setTimeout(() => syncDvrRingBudgetBackend(attempt + 1), BACKEND_POLL_MS);
      }
    });
}

/**
 * Request both host settings and cached predictions in parallel
 * @param hostname - The hostname to get data for
 * @returns Promise resolving to object with settings and predictions
 */
export async function requestHostData(hostname: string): Promise<{
  settings: IHostSettings;
  predictions: IImagePrediction[];
}> {
  try {
    syncDvrRingBudgetBackend();
    const [settings, predictions] = await Promise.all([
      requestHostSettings(hostname),
      requestCachedPredictions(hostname),
    ]);

    return {
      settings,
      predictions,
    };
  } catch (error) {
    log.error('host_data.request.failed', { [ATTR.hostname]: hostname, error });
    throw error;
  }
}

// =============================================================================
// Video Frame Inference
// =============================================================================

/**
 * Resolve video frame transfer kind with browser-specific handling.
 * - Chrome: 'bitmap' via MessageChannel (zero-copy), no fallback (throws if unavailable)
 * - Firefox: 'blob' via structured clone (compressed WebP)
 *
 * Video frames cannot fall back to URL (they're generated in content script, not fetchable).
 * Chrome must not fall back to blob (defeats MessageChannel purpose).
 */
async function resolveVideoFrameTransferKind(): Promise<VideoFrameTransferKind> {
  // Firefox: always use blob (no MessageChannel support)
  if (!IS_CHROME) {
    return 'blob';
  }

  // Chrome: must use bitmap via MessageChannel - wait for it or throw
  const channelReady = await waitForMessageChannel();
  if (!channelReady) {
    throw new Error('MessageChannel not available for video frame transfer (Chrome requires bitmap)');
  }
  return 'bitmap';
}

export interface VideoFrameParams {
  sample: CapturedFrameSample;
  hostname: string;
  priority: number;
  session?: UmbrellaSession;
}

/**
 * Send video frame for inference using comctx RPC.
 * Chrome: Zero-copy ImageBitmap via MessageChannel
 * Firefox: Compressed WebP blob via structured clone
 */
export async function requestVideoFrameInference(params: VideoFrameParams): Promise<void> {
  const { sample, hostname, priority, session } = params;
  const { bitmap, videoUrl, frameIndex, timestampSec, sessionId, originalWidth, originalHeight } = sample;

  const roundtripKey = `${sessionId}:${frameIndex}`;
  const parent = startRoundtrip(roundtripKey, {
    src: videoUrl,
    hostname,
    mediaKind: 'frame',
    session,
    attributes: {
      [ATTR.sessionId]: sessionId,
      [ATTR.frameIndex]: frameIndex,
      [ATTR.priority]: priority,
      [ATTR.timestampSec]: timestampSec,
    },
  });

  try {
    const base = {
      videoUrl,
      frameIndex,
      timestampSec,
      width: bitmap.width,
      height: bitmap.height,
      originalWidth,
      originalHeight,
      hostname,
      sessionId,
      priority,
      traceparent: injectTraceparent(parent),
    };

    const transferKind = await resolveVideoFrameTransferKind();
    let payload: IVideoFrameTransfer;

    switch (transferKind) {
      case 'bitmap': {
        // Chrome: Zero-copy transfer via MessageChannel
        payload = { ...base, kind: 'bitmap', bitmap };
        break;
      }
      case 'blob': {
        // Firefox: Compress to WebP and structured clone
        const blob = await bitmapToCompressedBlob(bitmap);
        bitmap.close(); // Clean up original bitmap after compression
        payload = { ...base, kind: 'blob', blob };
        break;
      }
      default:
        throw new Error(`Unsupported video frame transfer kind: ${transferKind as string}`);
    }

    const sendSpan = tracer.startSpan(SPAN.send, { attributes: { [ATTR.transferKind]: transferKind } }, parent);
    try {
      await backgroundRpc.postInferenceVideoFrame(payload);
      sendSpan.end();
    } catch (error) {
      endSpanWithError(sendSpan, error);
      throw error;
    }
    endRoundtrip(roundtripKey, { status: 'success' });
  } catch (error) {
    // Clean up bitmap on error if not already transferred/closed
    try {
      bitmap.close();
    } catch {
      // Already closed or transferred - ignore
    }
    endRoundtrip(roundtripKey, { status: 'error', error });
    log.error(
      'inference.frame.send.failed',
      { videoUrl, [ATTR.sessionId]: sessionId, [ATTR.frameIndex]: frameIndex, error },
      parent,
    );
    throw error;
  }
}

/** Cancel the latest playback frame while it is still waiting in the background queue. */
export async function cancelVideoSessionInference(sessionId: string): Promise<void> {
  try {
    await backgroundRpc.cancelVideoSessionInference(sessionId);
  } catch (error) {
    log.debug('inference.frame.cancel.failed', { [ATTR.sessionId]: sessionId, error });
  }
}

// =============================================================================
// GIF Frame Inference
// =============================================================================

export interface GifFrameParams {
  src: string;
  bitmap: ImageBitmap;
  hostname: string;
  sessionId: string;
  frameIndex: number;
  frameCount: number;
  originalWidth: number;
  originalHeight: number;
  priority: number;
  parent?: Context;
}

/**
 * Send a single decoded GIF frame for inference.
 * Uses the same transport as video frames (frames are generated in content, not
 * fetchable): Chrome transfers a zero-copy ImageBitmap via MessageChannel, Firefox
 * sends a compressed WebP blob. Takes ownership of the bitmap.
 */
export async function requestGifFrameInference(params: GifFrameParams): Promise<void> {
  const { src, bitmap, hostname, sessionId, frameIndex, frameCount, originalWidth, originalHeight, priority } = params;
  const parent = params.parent ?? ROOT_CONTEXT;
  const sendSpan = tracer.startSpan(SPAN.send, { attributes: { [ATTR.frameIndex]: frameIndex } }, parent);

  try {
    const base = {
      src,
      frameIndex,
      frameCount,
      sessionId,
      width: bitmap.width,
      height: bitmap.height,
      originalWidth,
      originalHeight,
      hostname,
      priority,
      traceparent: injectTraceparent(parent),
    };

    const transferKind = await resolveVideoFrameTransferKind();
    let payload: IGifFrameTransfer;

    switch (transferKind) {
      case 'bitmap': {
        payload = { ...base, kind: 'bitmap', bitmap };
        break;
      }
      case 'blob': {
        const blob = await bitmapToCompressedBlob(bitmap);
        bitmap.close();
        payload = { ...base, kind: 'blob', blob };
        break;
      }
      default:
        throw new Error(`Unsupported GIF frame transfer kind: ${transferKind as string}`);
    }

    sendSpan.setAttribute(ATTR.transferKind, transferKind);
    await backgroundRpc.postInferenceGifFrame(payload);
    sendSpan.end();
  } catch (error) {
    try {
      bitmap.close();
    } catch {
      // Already closed or transferred - ignore
    }
    endSpanWithError(sendSpan, error);
    log.error(
      'inference.gif_frame.send.failed',
      { [ATTR.src]: src, [ATTR.sessionId]: sessionId, [ATTR.frameIndex]: frameIndex, error },
      parent,
    );
    throw error;
  }
}
