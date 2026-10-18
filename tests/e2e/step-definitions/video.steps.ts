import { Given, Then, When } from '@wdio/cucumber-framework';

import { PRE_MASK_LEAD_SEC } from '../../../utils/lookahead/lattice.js';
import {
  buildGalleryUrl,
  buildVideoFixtureUrl,
  INFERENCE_TIMEOUT,
  Selectors,
  type GalleryModeType,
  type VideoFixture,
} from '../constants/index.js';
import { waitWithVideoDiagnostics } from '../utils/video.js';

/**
 * Video slots are element-anchored: they live in page DOM next to the video (so
 * player chrome can render above them), unlike image masks which live in the
 * layer's shadow root. Hidden slots stay in the DOM, so count by visibility.
 */
const OVERLAY_STABLE_WINDOW_MS = 2000;
const TAP_RESOLUTION_TIMEOUT = 20_000;
const VIDEO_TAP_ATTR = 'data-hb-video-tap';
const PRESENTED_WINDOW_SEC = 0.4;
const RAF_ORDER_SLACK_SEC = 0.05;

const countVisibleOnPage = async (selector: string): Promise<number> =>
  browser.execute((sel: string) => {
    let visible = 0;
    for (const el of globalThis.document.querySelectorAll<HTMLElement>(sel)) {
      if (el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null) visible += 1;
    }
    return visible;
  }, selector);

/**
 * Video is not a default processing target; enable it via the popup chip.
 * Assumes the policy is already 'process' (the global-policy step ensures that).
 */
Given('video processing is enabled', async () => {
  const extensionPath = await browser.getExtensionPath();
  await browser.url(`${extensionPath}/popup.html`);
  const chip = '[data-testid="target-video"]';
  await $(chip).waitForDisplayed({ timeout: 15000 });

  const isPressed = async () => (await $(chip).getAttribute('aria-pressed')) === 'true';
  if (await isPressed()) return;
  await $(chip).click();
  await browser.waitUntil(isPressed, { timeout: 15000, timeoutMsg: 'Failed to enable the video processing target' });
});

Given('I open the video test page with {string} images', async (mode: string) => {
  await browser.url(buildGalleryUrl({ mode: mode as GalleryModeType, count: 1 }));
  await $(Selectors.GALLERY_IMAGE).waitForExist({ timeout: 15000 });
});

/**
 * Thumbnail path: a video whose poster is a known-unsafe gallery image. The
 * poster needs no video data, so the verdict must arrive without playback.
 * The src points at a nonexistent file on purpose — attachment requires a
 * resolved source, but the Thumbnail must not wait for media readiness.
 */
When('I inject a video using the first gallery image as poster', async () => {
  await browser.execute((videoSelector: string) => {
    const img = globalThis.document.querySelector<HTMLImageElement>('main img');
    const poster = img?.currentSrc || img?.src || '';
    const video = globalThis.document.createElement('video');
    video.id = videoSelector.slice(1);
    video.muted = true;
    video.preload = 'none';
    video.width = 480;
    video.height = 360;
    video.poster = poster;
    video.src = '/hb-e2e-nonexistent.mp4';
    globalThis.document.querySelector('main')?.append(video);
    // Offscreen sessions defer capture until viewport re-entry by design;
    // these scenarios assert the in-view pipeline, so bring the video in view.
    video.scrollIntoView({ block: 'center' });
  }, Selectors.TEST_VIDEO);
});

When('I inject and play a safe video using {string}', async (mode: string) => {
  await injectAndPlayFixtureVideo('safe', mode as VideoSourceMode);
});

type VideoSourceMode = 'src' | 'source-child';

const playTestVideo = async (): Promise<string | null> =>
  browser.executeAsync((videoSelector: string, done: (failure: string | null) => void) => {
    const video = globalThis.document.querySelector<HTMLVideoElement>(videoSelector);
    if (!video) {
      done('test video missing');
      return;
    }
    video
      .play()
      .then(() => done(null))
      .catch((err: { name?: string; message?: string } | null) => {
        if (err?.name === 'NotAllowedError') {
          done('needs-activation');
          return;
        }
        done(`play() rejected: ${err?.name ?? 'Error'}: ${err?.message ?? ''}`);
      });
  }, Selectors.TEST_VIDEO);

async function injectFixtureVideo(fixture: VideoFixture, sourceMode: VideoSourceMode): Promise<void> {
  await browser.execute(
    (url: string, mode: VideoSourceMode, videoSelector: string) => {
      const doc = globalThis.document;
      const video = doc.createElement('video');
      video.id = videoSelector.slice(1);
      video.muted = true;
      video.loop = true;
      video.crossOrigin = 'anonymous';
      if (mode === 'source-child') {
        const source = doc.createElement('source');
        source.src = url;
        source.type = 'video/webm';
        video.append(source);
      } else {
        video.src = url;
      }
      doc.querySelector('main')?.append(video);
      video.scrollIntoView({ block: 'center' });
    },
    buildVideoFixtureUrl(fixture),
    sourceMode,
    Selectors.TEST_VIDEO,
  );
}

async function startTestVideo(fixture: string): Promise<void> {
  let failure = await playTestVideo();
  if (failure === 'needs-activation') {
    await $(Selectors.TEST_VIDEO).click();
    failure = await playTestVideo();
  }
  if (failure) {
    throw new Error(`Failed to start the ${fixture} test video — ${failure}`);
  }
}

async function injectAndPlayFixtureVideo(fixture: VideoFixture, sourceMode: VideoSourceMode): Promise<void> {
  await injectFixtureVideo(fixture, sourceMode);
  await startTestVideo(fixture);
}

Then('the video is verdicted {string} within the inference timeout', async (verdict: string) => {
  const attr = `data-haramblock-processed-${verdict}`;
  await waitWithVideoDiagnostics(
    async () => {
      const value = await browser.execute(
        (sel: string, a: string) => globalThis.document.querySelector(sel)?.getAttribute(a),
        Selectors.TEST_VIDEO,
        attr,
      );
      return value !== null && value !== undefined;
    },
    {
      timeout: INFERENCE_TIMEOUT,
      failureMessage: `Video was not verdicted "${verdict}" (missing ${attr})`,
    },
  );
});

Then('I should see at least {string} video mask overlays', async (count: string) => {
  const minExpected = parseInt(count, 10);
  await waitWithVideoDiagnostics(
    async () => (await countVisibleOnPage(Selectors.VIDEO_SEGMENT_OVERLAY)) >= minExpected,
    {
      timeout: INFERENCE_TIMEOUT,
      failureMessage: `Expected at least ${minExpected} video mask overlays, but timed out`,
    },
  );
});

Then('I should see exactly {string} video mask overlays', async (count: string) => {
  const expected = parseInt(count, 10);
  const stableWindowEnd = Date.now() + OVERLAY_STABLE_WINDOW_MS;
  while (Date.now() < stableWindowEnd) {
    expect(await countVisibleOnPage(Selectors.VIDEO_SEGMENT_OVERLAY)).toBe(expected);
    await browser.pause(250);
  }
});

Then('the video tap is {string}', async (tap: string) => {
  await waitWithVideoDiagnostics(
    async () =>
      (await browser.execute(
        (sel: string, attr: string) => globalThis.document.querySelector(sel)?.getAttribute(attr) ?? null,
        Selectors.TEST_VIDEO,
        VIDEO_TAP_ATTR,
      )) === tap,
    { timeout: TAP_RESOLUTION_TIMEOUT, failureMessage: `Expected ${VIDEO_TAP_ATTR}="${tap}"` },
  );
});

When('I inject and play a {string} video through a minimal MSE appender', async (fixture: string) => {
  await browser.execute(
    (url: string, videoSelector: string) => {
      const doc = globalThis.document;
      const video = doc.createElement('video');
      video.id = videoSelector.slice(1);
      video.muted = true;
      video.loop = true;
      const mediaSource = new MediaSource();
      video.src = URL.createObjectURL(mediaSource);
      mediaSource.addEventListener(
        'sourceopen',
        () => {
          const mime = [
            'video/webm; codecs="vp9"',
            'video/webm; codecs="vp8"',
            'video/webm; codecs="av01.0.05M.08"',
          ].find(type => MediaSource.isTypeSupported(type));
          if (!mime) return;
          const buffer = mediaSource.addSourceBuffer(mime);
          void fetch(url)
            .then(response => response.arrayBuffer())
            .then(bytes => {
              const chunkBytes = 256 * 1024;
              let offset = 0;
              const appendNext = () => {
                if (offset >= bytes.byteLength) {
                  mediaSource.endOfStream();
                  return;
                }
                buffer.appendBuffer(bytes.slice(offset, offset + chunkBytes));
                offset += chunkBytes;
              };
              buffer.addEventListener('updateend', appendNext);
              appendNext();
            });
        },
        { once: true },
      );
      doc.querySelector('main')?.append(video);
      video.scrollIntoView({ block: 'center' });
    },
    buildVideoFixtureUrl(fixture as VideoFixture),
    Selectors.TEST_VIDEO,
  );
  await startTestVideo(fixture);
});

When('I inject and play an {string} video from a plain blob URL', async (fixture: string) => {
  const failure = await browser.executeAsync(
    (url: string, videoSelector: string, done: (failure: string | null) => void) => {
      const doc = globalThis.document;
      fetch(url)
        .then(response => response.blob())
        .then(blob => {
          const video = doc.createElement('video');
          video.id = videoSelector.slice(1);
          video.muted = true;
          video.loop = true;
          video.src = URL.createObjectURL(blob);
          doc.querySelector('main')?.append(video);
          video.scrollIntoView({ block: 'center' });
          done(null);
        })
        .catch((error: Error) => done(error.message));
    },
    buildVideoFixtureUrl(fixture as VideoFixture),
    Selectors.TEST_VIDEO,
  );
  if (failure) throw new Error(`Failed to load the ${fixture} fixture as a blob — ${failure}`);
  await startTestVideo(fixture);
});

When('I inject a paused {string} video using {string}', async (fixture: string, mode: string) => {
  await injectFixtureVideo(fixture as VideoFixture, mode as VideoSourceMode);
});

let firstUnsafePointSec: number | null = null;

When('lookahead analysis has published an unsafe sample for the video', async () => {
  firstUnsafePointSec = null;
  await browser.waitUntil(
    async () => {
      firstUnsafePointSec = await readFirstUnsafePointSec();
      return firstUnsafePointSec !== null;
    },
    { timeout: INFERENCE_TIMEOUT, interval: 2000, timeoutMsg: 'Lookahead never published an unsafe sample' },
  );
});

When('I play the test video while recording mask visibility', async () => {
  await browser.execute(
    (videoSelector: string, overlaySelector: string) => {
      const doc = globalThis.document;
      const video = doc.querySelector<HTMLVideoElement>(videoSelector);
      const log: { t: number; visible: boolean }[] = [];
      (globalThis as unknown as { __hbMaskLog?: typeof log }).__hbMaskLog = log;
      const record = () => {
        const overlay = doc.querySelector<HTMLElement>(overlaySelector);
        if (video) log.push({ t: video.currentTime, visible: overlay?.checkVisibility() ?? false });
        requestAnimationFrame(record);
      };
      requestAnimationFrame(record);
    },
    Selectors.TEST_VIDEO,
    Selectors.VIDEO_SEGMENT_OVERLAY,
  );
  await startTestVideo('turns-unsafe');
});

type MaskLogEntry = { t: number; visible: boolean };

const readMaskLog = async (): Promise<MaskLogEntry[]> =>
  browser.execute(() => (globalThis as unknown as { __hbMaskLog?: MaskLogEntry[] }).__hbMaskLog ?? []);

const requireFirstUnsafePointSec = (): number => {
  if (firstUnsafePointSec === null) throw new Error('No unsafe sample was published');
  return firstUnsafePointSec;
};

const entriesBeforeFirstReaching = (log: MaskLogEntry[], mediaTimeSec: number): MaskLogEntry[] => {
  const firstReach = log.findIndex(entry => entry.t >= mediaTimeSec);
  return firstReach === -1 ? log : log.slice(0, firstReach);
};

Then('the mask was visible when playback reached the first unsafe sample', async () => {
  const unsafeAt = requireFirstUnsafePointSec();
  await waitWithVideoDiagnostics(
    async () => (await readMaskLog()).some(entry => entry.t > unsafeAt + PRESENTED_WINDOW_SEC),
    { timeout: INFERENCE_TIMEOUT, failureMessage: `Playback never passed the unsafe sample at ${unsafeAt}s` },
  );
  const presented = (await readMaskLog()).filter(
    entry => entry.t >= unsafeAt + RAF_ORDER_SLACK_SEC && entry.t <= unsafeAt + PRESENTED_WINDOW_SEC,
  );
  expect(presented.length).toBeGreaterThan(0);
  expect(presented.filter(entry => !entry.visible)).toEqual([]);
});

Then('no mask was visible over the clean span before it', async () => {
  const publishedAfterPlayback = await readFirstUnsafePointSec();
  const unsafeAt = Math.min(requireFirstUnsafePointSec(), publishedAfterPlayback ?? Infinity);
  const cleanSpanEnd = unsafeAt - PRE_MASK_LEAD_SEC - RAF_ORDER_SLACK_SEC;
  const isPlaying = (entry: MaskLogEntry) => entry.t > 0;
  const cleanSpan = entriesBeforeFirstReaching(await readMaskLog(), unsafeAt).filter(
    entry => isPlaying(entry) && entry.t <= cleanSpanEnd,
  );
  expect(cleanSpan.length).toBeGreaterThan(0);
  expect(cleanSpan.filter(entry => entry.visible)).toEqual([]);
});

const DEFAULT_SCORE_THRESHOLD = 0.2;

async function readFirstUnsafePointSec(): Promise<number | null> {
  const testWindow = await browser.getWindowHandle();
  const extensionPath = await browser.getExtensionPath();
  const { handle: popupWindow } = await browser.createWindow('window');
  await browser.switchToWindow(popupWindow);
  try {
    await browser.url(`${extensionPath}/popup.html`);
    return await browser.executeAsync((scoreThreshold: number, done: (pointSec: number | null) => void) => {
      const request = globalThis.indexedDB.open('MediaCacheDatabase');
      request.onerror = () => done(null);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('videoSampleBuckets')) {
          db.close();
          done(null);
          return;
        }
        const read = db.transaction('videoSampleBuckets', 'readonly').objectStore('videoSampleBuckets').getAll();
        read.onsuccess = () => {
          db.close();
          const buckets = read.result as { samples: { pointUs: number; topUnsafeScore: number }[] }[];
          const unsafePoints = buckets
            .flatMap(bucket => bucket.samples)
            .filter(sample => sample.topUnsafeScore >= scoreThreshold)
            .map(sample => sample.pointUs);
          done(unsafePoints.length > 0 ? Math.min(...unsafePoints) / 1e6 : null);
        };
        read.onerror = () => done(null);
      };
    }, DEFAULT_SCORE_THRESHOLD);
  } finally {
    await browser.closeWindow();
    await browser.switchToWindow(testWindow);
  }
}
