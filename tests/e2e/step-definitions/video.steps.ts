import { Given, Then, When } from '@wdio/cucumber-framework';

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

When('I inject and play an unsafe video', async () => {
  await injectAndPlayFixtureVideo('unsafe', 'src');
});

When('I inject and play a video that turns unsafe mid-playback', async () => {
  await injectAndPlayFixtureVideo('turns-unsafe', 'src');
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

async function injectAndPlayFixtureVideo(fixture: VideoFixture, sourceMode: VideoSourceMode): Promise<void> {
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

  let failure = await playTestVideo();
  if (failure === 'needs-activation') {
    await $(Selectors.TEST_VIDEO).click();
    failure = await playTestVideo();
  }
  if (failure) {
    throw new Error(`Failed to start the ${fixture} test video — ${failure}`);
  }
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
  const canvasSelector = `${Selectors.VIDEO_SEGMENT_OVERLAY} canvas`;

  await waitWithVideoDiagnostics(async () => (await countVisibleOnPage(canvasSelector)) >= minExpected, {
    timeout: INFERENCE_TIMEOUT,
    failureMessage: `Expected at least ${minExpected} video mask overlays, but timed out`,
  });
});

Then('I should see exactly {string} video mask overlays', async (count: string) => {
  const expected = parseInt(count, 10);
  const stableWindowEnd = Date.now() + OVERLAY_STABLE_WINDOW_MS;
  while (Date.now() < stableWindowEnd) {
    // eslint-disable-next-line no-await-in-loop
    expect(await countVisibleOnPage(Selectors.VIDEO_SEGMENT_OVERLAY)).toBe(expected);
    // eslint-disable-next-line no-await-in-loop
    await browser.pause(250);
  }
});

/**
 * The DVR takes over once its first frame is buffered: its element-anchored
 * slot appears next to the video and the native element is visually hidden
 * (opacity 0), while the session keeps sampling at the live edge. Both are
 * checked in one poll tick: a looping video re-warms at every loop restart
 * (flush + re-warm), briefly revealing the native element again.
 */
Then('the DVR canvas player replaces the native video', async () => {
  const canvasSelector = `${Selectors.VIDEO_DVR_PLAYER} canvas`;
  await waitWithVideoDiagnostics(
    async () => {
      if ((await countVisibleOnPage(canvasSelector)) === 0) return false;
      const nativeOpacity = await browser.execute(
        (sel: string) => globalThis.document.querySelector<HTMLVideoElement>(sel)?.style.opacity,
        Selectors.TEST_VIDEO,
      );
      return nativeOpacity === '0';
    },
    {
      timeout: INFERENCE_TIMEOUT,
      failureMessage: 'Expected the DVR canvas player to replace the native video, but timed out',
    },
  );
});

/**
 * Whole-blur watcher: records (in-page) whether the machine's whole-video blur
 * class lands on the native element after the DVR canvas has taken over. The
 * continuous DVR composites verdicts into the running presentation, so the
 * blur may appear only before takeover (attachment / warm-up cover).
 */
When('I watch the native video for whole-blur changes', async () => {
  const failure = await browser.execute(
    (videoSelector: string, dvrSelector: string, blurClass: string) => {
      const doc = globalThis.document;
      const video = doc.querySelector<HTMLVideoElement>(videoSelector);
      if (!video) return 'test video missing';
      const state = {
        takenOver: false,
        blurAppliedAfterTakeover: false,
        wasBlurred: video.classList.contains(blurClass),
      };
      (globalThis as unknown as { __hbBlurWatch?: typeof state }).__hbBlurWatch = state;
      new MutationObserver(() => {
        const blurred = video.classList.contains(blurClass);
        if (blurred && !state.wasBlurred && state.takenOver) state.blurAppliedAfterTakeover = true;
        state.wasBlurred = blurred;
      }).observe(video, { attributes: true, attributeFilter: ['class'] });
      const poll = setInterval(() => {
        if (doc.querySelector(`${dvrSelector} canvas`) && video.style.opacity === '0') {
          state.takenOver = true;
          clearInterval(poll);
        }
      }, 50);
      return null;
    },
    Selectors.TEST_VIDEO,
    Selectors.VIDEO_DVR_PLAYER,
    Selectors.WHOLE_BLUR_CLASS,
  );
  if (failure) throw new Error(`Failed to install the whole-blur watcher — ${failure}`);
});

Then('no whole-blur was applied after the DVR canvas took over', async () => {
  const state = await browser.execute(
    () =>
      (globalThis as unknown as { __hbBlurWatch?: { takenOver: boolean; blurAppliedAfterTakeover: boolean } })
        .__hbBlurWatch ?? null,
  );
  if (!state) throw new Error('Whole-blur watcher was never installed');
  expect(state.takenOver).toBe(true);
  expect(state.blurAppliedAfterTakeover).toBe(false);
});
