// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MediaPipeline, type MediaPipelineDeps } from '@/entrypoints/content/core/MediaPipeline';

import type { BadgeCounter } from '@/entrypoints/content/core/BadgeCounter';
import type { DomObserver, DomObserverConfig } from '@/entrypoints/content/core/DomObserver';
import type { ImageProcessor } from '@/entrypoints/content/core/ImageProcessor';
import type { IHostSettings } from '@/utils/types';

const listeners = vi.hoisted(() => ({
  imagePredictions: undefined as ((data: any) => void) | undefined,
  gifFramePredictions: undefined as ((data: any) => void) | undefined,
  framePredictions: undefined as ((data: any) => void) | undefined,
  contextMenuToggle: undefined as ((data: any) => void) | undefined,
}));

vi.mock('@/entrypoints/content/communication/listener', () => ({
  onImagePredictions: (cb: (data: any) => void) => {
    listeners.imagePredictions = cb;
    return vi.fn();
  },
  onGifFramePredictions: (cb: (data: any) => void) => {
    listeners.gifFramePredictions = cb;
    return vi.fn();
  },
  onFramePredictions: (cb: (data: any) => void) => {
    listeners.framePredictions = cb;
    return vi.fn();
  },
  onContextMenuToggle: (cb: (data: any) => void) => {
    listeners.contextMenuToggle = cb;
    return vi.fn();
  },
}));

const hostSettings = (policy: IHostSettings['policy']): IHostSettings =>
  ({ hostname: 'example.com', policy }) as IHostSettings;

const processPolicy = (targets: Partial<{ image: boolean; gif: boolean; video: boolean }>) =>
  ({ behavior: 'process', targets: { image: false, gif: false, video: false, ...targets } }) as IHostSettings['policy'];

describe('MediaPipeline', () => {
  let deps: MediaPipelineDeps;
  let domConfig: DomObserverConfig;
  let dom: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; markAllDirty: ReturnType<typeof vi.fn> };
  let imageProcessor: Record<string, ReturnType<typeof vi.fn>>;
  let badgeDispose: ReturnType<typeof vi.fn>;

  const makePipeline = (
    policy: IHostSettings['policy'],
    { videoProcessingAvailable = true }: { videoProcessingAvailable?: boolean } = {},
  ): MediaPipeline => new MediaPipeline({ hostSettings: hostSettings(policy), videoProcessingAvailable }, deps);

  beforeEach(() => {
    dom = { start: vi.fn(), stop: vi.fn(), markAllDirty: vi.fn() };
    imageProcessor = {
      processAll: vi.fn(),
      handleSrcChange: vi.fn(),
      handleRemoved: vi.fn(),
      handleInferenceResults: vi.fn(),
      handleGifFrameResults: vi.fn(),
      toggleImage: vi.fn(),
      seedCache: vi.fn(),
      dispose: vi.fn(),
    };
    badgeDispose = vi.fn();
    deps = {
      badgeCounter: { dispose: badgeDispose } as unknown as BadgeCounter,
      imageProcessor: imageProcessor as unknown as ImageProcessor,
      createDomObserver: config => {
        domConfig = config;
        return dom as unknown as DomObserver;
      },
      video: {
        handleVideos: vi.fn(),
        handleAttributeChange: vi.fn(),
        disposeSession: vi.fn(),
        sessions: { disposeAll: vi.fn(), handleResults: vi.fn() },
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('verdict arrival', () => {
    it('routes matching-hostname image verdicts to the processor and schedules reconciliation', async () => {
      vi.useFakeTimers();
      makePipeline(processPolicy({ image: true })).start(document.body);

      const results = [{ src: 'https://example.com/a.jpg' }];
      listeners.imagePredictions?.({ hostname: 'example.com', results });

      expect(imageProcessor.processAll).not.toHaveBeenCalled();
      expect(imageProcessor.handleInferenceResults).toHaveBeenCalledWith(results);
      expect(dom.markAllDirty).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(dom.markAllDirty).toHaveBeenCalledTimes(1);
    });

    it('coalesces reconciliation across a burst of verdict batches', async () => {
      vi.useFakeTimers();
      makePipeline(processPolicy({ image: true })).start(document.body);

      for (let i = 0; i < 5; i++) {
        listeners.imagePredictions?.({ hostname: 'example.com', results: [] });
      }
      await vi.advanceTimersByTimeAsync(100);

      expect(dom.markAllDirty).toHaveBeenCalledTimes(1);
    });

    it('ignores verdicts broadcast for another hostname', () => {
      makePipeline(processPolicy({ image: true })).start(document.body);

      listeners.imagePredictions?.({ hostname: 'other.com', results: [] });

      expect(imageProcessor.handleInferenceResults).not.toHaveBeenCalled();
      expect(dom.markAllDirty).not.toHaveBeenCalled();
    });

    it('routes GIF frame verdicts the same way', async () => {
      vi.useFakeTimers();
      makePipeline(processPolicy({ gif: true })).start(document.body);

      const results = [{ src: 'https://example.com/a.gif' }];
      listeners.gifFramePredictions?.({ hostname: 'example.com', results });

      expect(imageProcessor.handleGifFrameResults).toHaveBeenCalledWith(results);
      await vi.advanceTimersByTimeAsync(100);
      expect(dom.markAllDirty).toHaveBeenCalledTimes(1);
    });
  });

  describe('media observed', () => {
    const img = () => document.createElement('img');
    const video = () => document.createElement('video');

    it('processes images under blacklist behavior', () => {
      makePipeline({ behavior: 'blacklist' } as IHostSettings['policy']);
      const el = img();

      domConfig.onMediaObserved([el], []);

      expect(imageProcessor.processAll).toHaveBeenCalledWith([el]);
    });

    it('skips images when neither image nor gif targeting is on', () => {
      makePipeline(processPolicy({ video: true }));

      domConfig.onMediaObserved([img()], []);

      expect(imageProcessor.processAll).not.toHaveBeenCalled();
    });

    it('routes videos to the video path only when videos are routed', () => {
      makePipeline(processPolicy({ video: true }));
      const el = video();

      domConfig.onMediaObserved([], [el]);

      expect(deps.video.handleVideos).toHaveBeenCalledWith([el], expect.objectContaining({ hostname: 'example.com' }));
    });

    it('leaves videos native when video processing is unavailable', () => {
      makePipeline(processPolicy({ video: true }), { videoProcessingAvailable: false });

      domConfig.onMediaObserved([], [video()]);

      expect(deps.video.handleVideos).not.toHaveBeenCalled();
    });
  });

  describe('media removed', () => {
    it('treats a still-connected element as a re-parent, not a removal', () => {
      makePipeline(processPolicy({ image: true }));
      const el = document.createElement('img');
      document.body.appendChild(el);

      domConfig.onMediaRemoved([el]);

      expect(imageProcessor.handleRemoved).not.toHaveBeenCalled();
      el.remove();
    });

    it('disposes disconnected images and video sessions', () => {
      makePipeline(processPolicy({ image: true, video: true }));
      const imgEl = document.createElement('img');
      const videoEl = document.createElement('video');

      domConfig.onMediaRemoved([imgEl, videoEl]);

      expect(imageProcessor.handleRemoved).toHaveBeenCalledWith(imgEl);
      expect(deps.video.disposeSession).toHaveBeenCalledWith(videoEl);
    });
  });

  describe('attributes changed', () => {
    it('routes image src changes through the invalidation path when targeted', () => {
      makePipeline(processPolicy({ image: true }));
      const el = document.createElement('img');

      domConfig.onAttributesChanged([el]);

      expect(imageProcessor.handleSrcChange).toHaveBeenCalledWith(el);
    });

    it('routes video attribute changes when videos are routed', () => {
      makePipeline(processPolicy({ video: true }));
      const el = document.createElement('video');

      domConfig.onAttributesChanged([el]);

      expect(deps.video.handleAttributeChange).toHaveBeenCalledWith(
        el,
        expect.objectContaining({ hostname: 'example.com' }),
      );
    });
  });

  it('quick toggle from the context menu reaches the processor', () => {
    makePipeline(processPolicy({ image: true })).start(document.body);

    listeners.contextMenuToggle?.({ src: 'https://example.com/a.jpg', forcedVisibility: 'visible' });

    expect(imageProcessor.toggleImage).toHaveBeenCalledWith('https://example.com/a.jpg', 'visible');
  });

  it('stop() disposes the observer, processor, badge, and video sessions', () => {
    const pipeline = makePipeline(processPolicy({ image: true }));
    pipeline.start(document.body);

    pipeline.stop();

    expect(dom.stop).toHaveBeenCalled();
    expect(imageProcessor.dispose).toHaveBeenCalled();
    expect(badgeDispose).toHaveBeenCalled();
    expect(deps.video.sessions.disposeAll).toHaveBeenCalled();
  });
});
