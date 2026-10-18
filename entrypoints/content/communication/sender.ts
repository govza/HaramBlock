import { ROOT_CONTEXT, type Context, type Span } from '@opentelemetry/api';

import { resolveImageSource } from '@/entrypoints/content/core/imageSource';
import { bitmapToCompressedBlob } from '@/entrypoints/content/video/sampling/compression';
import {
  IS_CHROME,
  IMAGE_TRANSFER_KIND,
  IMAGE_FALLBACK_KIND,
  type ImageTransferKind,
  type VideoFrameTransferKind,
} from '@/utils/constants/environment';
import { backgroundRpc, waitForMessageChannel } from '@/utils/messaging/content';
import {
  ATTR,
  getLogger,
  getTracer,
  injectTraceparent,
  METRIC,
  recordCounter,
  recordHistogram,
  videoIdentityAttributes,
} from '@/utils/telemetry';
import {
  endRoundtrip,
  endSpanWithError,
  SPAN,
  startRoundtrip,
  type UmbrellaSession,
} from '@/utils/telemetry/roundtrip';
import {
  type ForcedVisibility,
  type IHostSettings,
  type IImagePrediction,
  type IImageMetadata,
  type IImageTransfer,
  type IVideoFrameTransfer,
  type IGifFrameTransfer,
  type FrameSampleKind,
} from '@/utils/types';

import type { CapturedFrameSample } from '@/entrypoints/content/video/sampling/sample';
import type { VideoIdentity } from '@/utils/videoIdentity';

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

export async function requestVideoForcedVisibility(identity: VideoIdentity): Promise<ForcedVisibility> {
  try {
    return await backgroundRpc.getVideoForcedVisibility(identity);
  } catch (error) {
    log.error('video_forced_visibility.request.failed', { ...videoIdentityAttributes(identity), error });
    return 'auto';
  }
}

export async function requestVideoToggleUpdate(
  identity: VideoIdentity,
  origin: { sourceUrl: string; hostname: string },
  forcedVisibility: ForcedVisibility,
): Promise<void> {
  try {
    await backgroundRpc.updateVideoToggleState(identity, origin, forcedVisibility);
  } catch (error) {
    log.error('video_toggle.update.failed', { ...videoIdentityAttributes(identity), forcedVisibility, error });
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

export async function fetchMediaBlob(src: string): Promise<Blob> {
  const response = await fetch(src, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${src} (${response.status})`);
  }
  return response.blob();
}

async function buildPayload(
  hostname: string,
  image: HTMLImageElement,
  metadata: IImageMetadata,
  priority: number,
  parent: Context,
): Promise<IImageTransfer> {
  const requestStartAt = Date.now();
  const src = resolveImageSource(image);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const traceparent = injectTraceparent(parent);

  const transferKind = await resolveImageTransferKind();
  const captureSpan = tracer.startSpan(SPAN.capture, { attributes: { [ATTR.transferKind]: transferKind } }, parent);

  const fetchImageBlob = async (): Promise<{ blob: Blob; fetchTime: number }> => {
    const fetchStart = Date.now();
    const blob = await fetchMediaBlob(src);
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

  log.error('inference.send.failed', { [ATTR.src]: resolveImageSource(image), error: lastError }, parent);
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

/**
 * A content-generated frame packaged for its transport: the ImageBitmap itself where MessageChannel
 * can transfer it, or a compressed blob where only structured clone is available.
 */
type FrameTransfer = { kind: 'bitmap'; bitmap: ImageBitmap } | { kind: 'blob'; blob: Blob };

/** Release a bitmap that may already be closed or detached by a transfer. */
const closeBitmapQuietly = (bitmap: ImageBitmap): void => {
  try {
    bitmap.close();
  } catch {
    return;
  }
};

/**
 * Package a frame for the current transport, taking ownership of the bitmap: it is closed once
 * compressed to a blob, or when packaging fails.
 */
async function toFrameTransfer(bitmap: ImageBitmap, onEncoded?: (encodeMs: number) => void): Promise<FrameTransfer> {
  try {
    const transferKind = await resolveVideoFrameTransferKind();
    if (transferKind === 'bitmap') {
      return { kind: 'bitmap', bitmap };
    }
    const encodeStartedAt = performance.now();
    const blob = await bitmapToCompressedBlob(bitmap);
    onEncoded?.(performance.now() - encodeStartedAt);
    bitmap.close();
    return { kind: 'blob', blob };
  } catch (error) {
    closeBitmapQuietly(bitmap);
    throw error;
  }
}

export interface VideoFrameParams {
  sample: CapturedFrameSample;
  sampleKind: FrameSampleKind;
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
  const { sample, sampleKind, hostname, priority, session } = params;
  const { bitmap, mediaKey, sourceUrl, frameIndex, timestampSec, sessionId, originalWidth, originalHeight } = sample;

  const roundtripKey = `${sessionId}:${frameIndex}`;
  const parent = startRoundtrip(roundtripKey, {
    src: mediaKey,
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
      mediaKey,
      sourceUrl,
      frameIndex,
      timestampSec,
      width: bitmap.width,
      height: bitmap.height,
      originalWidth,
      originalHeight,
      hostname,
      sessionId,
      sampleKind,
      priority,
      traceparent: injectTraceparent(parent),
    };

    const transfer = await toFrameTransfer(bitmap, encodeMs =>
      recordHistogram(METRIC.samplerEncodeMs, encodeMs, {
        [ATTR.sessionId]: sessionId,
        [ATTR.transferKind]: 'blob',
      }),
    );
    const transferKind = transfer.kind;
    const payload: IVideoFrameTransfer = { ...base, ...transfer };
    recordCounter(METRIC.samplerFramesSent, 1, { [ATTR.transferKind]: transferKind });

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
    closeBitmapQuietly(bitmap);
    endRoundtrip(roundtripKey, { status: 'error', error });
    log.error(
      'inference.frame.send.failed',
      { [ATTR.src]: mediaKey, [ATTR.sessionId]: sessionId, [ATTR.frameIndex]: frameIndex, error },
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

    const transfer = await toFrameTransfer(bitmap);
    const transferKind = transfer.kind;
    const payload: IGifFrameTransfer = { ...base, ...transfer };

    sendSpan.setAttribute(ATTR.transferKind, transferKind);
    await backgroundRpc.postInferenceGifFrame(payload);
    sendSpan.end();
  } catch (error) {
    closeBitmapQuietly(bitmap);
    endSpanWithError(sendSpan, error);
    log.error(
      'inference.gif_frame.send.failed',
      { [ATTR.src]: src, [ATTR.sessionId]: sessionId, [ATTR.frameIndex]: frameIndex, error },
      parent,
    );
    throw error;
  }
}
