import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setCallerContext } from '@/utils/messaging/callerContext';
import { BackgroundRpc } from '@/utils/messaging/services/backgroundRpc';
import {
  EMPTY_CACHED_VIDEO_PREDICTIONS,
  type FrameInferenceResult,
  type IImageTransfer,
  type ImageInferenceResult,
  type IVideoCacheOrigin,
  type VideoIdentity,
} from '@/utils/types';

const makeRpc = (): BackgroundRpc =>
  // Subscription paths never touch the injected services
  new BackgroundRpc(
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );

const frameResults = [] as FrameInferenceResult[];
const imageResults = [] as ImageInferenceResult[];

describe('BackgroundRpc subscription reaping', () => {
  let rpc: BackgroundRpc;

  beforeEach(() => {
    rpc = makeRpc();
    setCallerContext({});
  });

  it('delivers emissions to a registered subscriber', () => {
    setCallerContext({ tabId: 1, frameId: 0 });
    const callback = vi.fn();
    rpc.onFramePredictions(callback);

    rpc.emitFramePredictions(frameResults, 'example.com');

    expect(callback).toHaveBeenCalledWith({ results: frameResults, hostname: 'example.com' });
  });

  it('releaseTab drops every subscription kind owned by that tab', () => {
    setCallerContext({ tabId: 7, frameId: 0 });
    const image = vi.fn();
    const frame = vi.fn();
    const gif = vi.fn();
    const toggle = vi.fn();
    rpc.onImagePredictions(image);
    rpc.onFramePredictions(frame);
    rpc.onGifFramePredictions(gif);
    rpc.onContextMenuToggle(toggle);

    rpc.releaseTab(7);

    rpc.emitImagePredictions(imageResults, 'example.com');
    rpc.emitFramePredictions(frameResults, 'example.com');
    rpc.emitGifFramePredictions([], 'example.com');
    rpc.emitContextMenuToggle('src', 'visible');

    expect(image).not.toHaveBeenCalled();
    expect(frame).not.toHaveBeenCalled();
    expect(gif).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
  });

  it('releaseTab leaves other tabs and context-free subscribers alone', () => {
    setCallerContext({ tabId: 7, frameId: 0 });
    const doomed = vi.fn();
    rpc.onFramePredictions(doomed);

    setCallerContext({ tabId: 8, frameId: 0 });
    const otherTab = vi.fn();
    rpc.onFramePredictions(otherTab);

    setCallerContext({});
    const popup = vi.fn();
    rpc.onFramePredictions(popup);

    rpc.releaseTab(7);
    rpc.emitFramePredictions(frameResults, 'example.com');

    expect(doomed).not.toHaveBeenCalled();
    expect(otherTab).toHaveBeenCalledOnce();
    expect(popup).toHaveBeenCalledOnce();
  });

  it('a resubscribe from the same tab+frame evicts the stale entry of the same kind', () => {
    setCallerContext({ tabId: 3, frameId: 5 });
    const stale = vi.fn();
    rpc.onFramePredictions(stale);

    setCallerContext({ tabId: 3, frameId: 5 });
    const fresh = vi.fn();
    rpc.onFramePredictions(fresh);

    rpc.emitFramePredictions(frameResults, 'example.com');

    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledOnce();
  });

  it('same tab, different frames coexist', () => {
    setCallerContext({ tabId: 3, frameId: 0 });
    const top = vi.fn();
    rpc.onFramePredictions(top);

    setCallerContext({ tabId: 3, frameId: 42 });
    const iframe = vi.fn();
    rpc.onFramePredictions(iframe);

    rpc.emitFramePredictions(frameResults, 'example.com');

    expect(top).toHaveBeenCalledOnce();
    expect(iframe).toHaveBeenCalledOnce();
  });

  it('resubscribe does not evict a different kind from the same frame', () => {
    setCallerContext({ tabId: 3, frameId: 0 });
    const image = vi.fn();
    rpc.onImagePredictions(image);

    setCallerContext({ tabId: 3, frameId: 0 });
    rpc.onFramePredictions(vi.fn());

    rpc.emitImagePredictions(imageResults, 'example.com');
    expect(image).toHaveBeenCalledOnce();
  });

  it('explicit unsubscribe still works', () => {
    setCallerContext({ tabId: 1, frameId: 0 });
    const callback = vi.fn();
    const id = rpc.onFramePredictions(callback);

    rpc.offFramePredictions(id);
    rpc.emitFramePredictions(frameResults, 'example.com');

    expect(callback).not.toHaveBeenCalled();
  });
});

describe('BackgroundRpc called from an incognito tab', () => {
  const imageCacheService = {
    getCachedPredictionsByHostname: vi.fn(),
    findValidBySrc: vi.fn(),
    setForcedVisibility: vi.fn(),
  };
  const videoPredictionCacheService = {
    getCached: vi.fn(),
    getForcedVisibility: vi.fn(),
    storeOwn: vi.fn(),
    setForcedVisibility: vi.fn(),
  };
  const inferenceService = { scheduleInferenceTask: vi.fn() };
  const hostSettingsService = { getHostSettings: vi.fn() };
  const identity: VideoIdentity = { kind: 'stable', key: 'yt:abc', durationSec: 10 };
  const origin: IVideoCacheOrigin = { sourceUrl: 'blob:x', pageUrl: 'https://example.com/w', hostname: 'example.com' };
  let rpc: BackgroundRpc;

  beforeEach(() => {
    rpc = new BackgroundRpc(
      hostSettingsService as never,
      imageCacheService as never,
      inferenceService as never,
      undefined as never,
      undefined as never,
      undefined as never,
      videoPredictionCacheService as never,
    );
    setCallerContext({ tabId: 1, frameId: 0, incognito: true });
  });

  it('reads nothing from the prediction caches', async () => {
    expect(await rpc.getCachedPredictions('example.com')).toEqual([]);
    expect(await rpc.getCachedImagePrediction('https://example.com/a.jpg', 'example.com')).toBeNull();
    expect(await rpc.getCachedVideoPredictions(identity, { aspectRatio: null })).toEqual(
      EMPTY_CACHED_VIDEO_PREDICTIONS,
    );
    expect(await rpc.getVideoForcedVisibility(identity)).toBe('auto');
  });

  it('writes nothing to the prediction caches', async () => {
    await rpc.setImageForcedVisibility('https://example.com/a.jpg', 'visible');
    await rpc.setVideoForcedVisibility(identity, origin, 'visible');
    await rpc.publishVideoSamples(identity, origin, []);

    expect(imageCacheService.setForcedVisibility).not.toHaveBeenCalled();
    expect(videoPredictionCacheService.setForcedVisibility).not.toHaveBeenCalled();
    expect(videoPredictionCacheService.storeOwn).not.toHaveBeenCalled();
  });

  it('schedules an image so that its verdict stays out of the image cache', async () => {
    hostSettingsService.getHostSettings.mockResolvedValue({});
    const image = {
      kind: 'url',
      src: 'https://example.com/a.jpg',
      hostname: 'example.com',
      metadata: {},
    } as unknown as IImageTransfer;

    await rpc.postInferenceImage(image);

    expect(inferenceService.scheduleInferenceTask).toHaveBeenCalledWith(expect.objectContaining({ isIncognito: true }));
  });

  it('reads host settings as an incognito caller without the content script saying so', async () => {
    await rpc.getHostSettings('example.com');

    expect(hostSettingsService.getHostSettings).toHaveBeenCalledWith('example.com', true);
  });

  it('runs inference under the incognito tab’s own host settings', async () => {
    hostSettingsService.getHostSettings.mockResolvedValue({});
    const media = { kind: 'url', src: 'https://example.com/a.jpg', hostname: 'example.com', metadata: {} };

    await rpc.postInferenceImage(media as unknown as IImageTransfer);
    await rpc.postInferenceVideoFrame(media as never);
    await rpc.postInferenceGifFrame(media as never);

    expect(hostSettingsService.getHostSettings.mock.calls).toEqual([
      ['example.com', true],
      ['example.com', true],
      ['example.com', true],
    ]);
  });

  it('keeps serving the caches to a normal tab', async () => {
    setCallerContext({ tabId: 2, frameId: 0, incognito: false });
    imageCacheService.getCachedPredictionsByHostname.mockResolvedValue([]);

    await rpc.getCachedPredictions('example.com');

    expect(imageCacheService.getCachedPredictionsByHostname).toHaveBeenCalledWith('example.com');
  });
});
