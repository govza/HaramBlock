import { Given, Then, When } from '@wdio/cucumber-framework';

import { buildGalleryUrl, INFERENCE_TIMEOUT, Selectors, type GalleryModeType } from '../constants/index.js';

/**
 * Video slots are element-anchored: they live in page DOM next to the video (so
 * player chrome can render above them), unlike image masks which live in the
 * layer's shadow root. Hidden slots stay in the DOM, so count by visibility.
 */
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

  await browser.waitUntil(
    async () => {
      const pressed = await browser.execute(
        (sel: string) => globalThis.document.querySelector(sel)?.getAttribute('aria-pressed'),
        chip,
      );
      if (pressed === 'true') return true;
      await browser.execute((sel: string) => globalThis.document.querySelector<HTMLElement>(sel)?.click(), chip);
      return false;
    },
    { timeout: 15000, interval: 500, timeoutMsg: 'Failed to enable the video processing target' },
  );
});

Given('I open the video test page with {string} images', async (mode: string) => {
  await browser.url(buildGalleryUrl({ mode: mode as GalleryModeType, count: 1 }));
  await $(Selectors.GALLERY_IMAGE).waitForExist({ timeout: 15000 });
});

/**
 * Thumbnail path: a video whose poster is a known-unsafe gallery image. The
 * poster needs no video data, so the verdict must arrive without playback.
 * The src points at a nonexistent file on purpose — adoption requires a
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

/**
 * Playback path: record a short neutral canvas animation into a video blob
 * and play it. blob: sources are CORS-safe for frame capture. Mode
 * "source-child" attaches the source via a <source> element, exercising the
 * loadstart adoption path (the <video> element itself never has a src
 * attribute). The recording mimeType is negotiated per platform (Firefox on
 * Android lacks some encoders), and every failure path reports which stage
 * broke so CI logs stay diagnosable.
 */
When('I inject and play a generated safe video using {string}', async (mode: string) => {
  await injectAndPlayGeneratedVideo(mode, 'safe');
});

/**
 * DVR path: the recorded frames replay the known-unsafe gallery image, so
 * playback Frame Samples verdict unsafe and composite into the delayed canvas
 * presentation the continuous DVR already runs. Recorded longer than the
 * presentation delay so the ring buffer can span D within one loop.
 */
When('I inject and play a generated unsafe video', async () => {
  await injectAndPlayGeneratedVideo('src', 'unsafe');
});

/**
 * Mid-playback verdict path: neutral frames first (Thumbnail and early Frame
 * Samples verdict safe, the DVR canvas takes over unblurred), then the
 * known-unsafe gallery image appears, so the unsafe verdict lands while the
 * DVR is already presenting. Recorded long so the loop-restart re-warm (which
 * legitimately re-blurs a masked session) stays outside the assertion window.
 */
When('I inject and play a generated video that turns unsafe mid-playback', async () => {
  await injectAndPlayGeneratedVideo('src', 'turns-unsafe');
});

type GeneratedContent = 'safe' | 'unsafe' | 'turns-unsafe';

async function injectAndPlayGeneratedVideo(mode: string, content: GeneratedContent): Promise<void> {
  const failure = await browser.executeAsync(
    (
      sourceMode: string,
      contentMode: GeneratedContent,
      videoSelector: string,
      done: (failure: string | null) => void,
    ) => {
      // Read name/message as plain properties: `instanceof Error` is false for
      // page DOMExceptions inside the Marionette sandbox, which previously
      // collapsed rejections to "{}" in CI logs.
      const describe = (err: unknown) => {
        const like = err as { name?: unknown; message?: unknown } | null | undefined;
        const name = typeof like?.name === 'string' ? like.name : '';
        const message = typeof like?.message === 'string' ? like.message : '';
        if (name || message) return `${name || 'Error'}: ${message}`;
        if (typeof err === 'string') return err;
        return JSON.stringify(err) ?? 'unknown error';
      };
      const record = (unsafeImage: HTMLImageElement | null) => {
        try {
          const doc = globalThis.document;
          const canvas = doc.createElement('canvas');
          // The unsafe recording must survive the Firefox transport (WebP
          // re-compression of the sampled frame): record large with a thin
          // border so the replayed image keeps enough detail to be detected.
          canvas.width = unsafeImage ? 480 : 320;
          canvas.height = unsafeImage ? 360 : 240;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            done('canvas 2d context unavailable');
            return;
          }
          let hue = 0;
          const recordingStart = Date.now();
          const draw = () => {
            hue = (hue + 7) % 360;
            ctx.fillStyle = `hsl(${hue}, 60%, 60%)`;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            // 'turns-unsafe' opens with neutral frames so the unsafe verdict
            // lands mid-playback, after the DVR canvas has taken over.
            const unsafeNow = contentMode !== 'turns-unsafe' || Date.now() - recordingStart >= 2000;
            if (unsafeImage && unsafeNow) {
              // Replay the known-unsafe gallery image; the hue border keeps the
              // encoder emitting distinct frames.
              ctx.drawImage(unsafeImage, 4, 4, canvas.width - 8, canvas.height - 8);
            }
          };
          draw();
          const interval = setInterval(draw, 100);

          const stream = canvas.captureStream(10);
          const candidates = ['video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
          const mimeType = candidates.find(type => globalThis.MediaRecorder.isTypeSupported(type));
          const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
          const chunks: Blob[] = [];
          recorder.ondataavailable = event => {
            if (event.data.size > 0) chunks.push(event.data);
          };
          recorder.onerror = event => {
            clearInterval(interval);
            done(`MediaRecorder error: ${describe((event as unknown as { error?: unknown }).error)}`);
          };
          recorder.onstop = () => {
            clearInterval(interval);
            if (chunks.length === 0) {
              done(`MediaRecorder produced no data (mimeType: ${recorder.mimeType || 'default'})`);
              return;
            }
            const blobType = recorder.mimeType || mimeType || 'video/webm';
            const url = URL.createObjectURL(new Blob(chunks, { type: blobType }));
            const video = doc.createElement('video');
            video.id = videoSelector.slice(1);
            video.muted = true;
            video.loop = true;
            video.width = canvas.width;
            video.height = canvas.height;
            if (sourceMode === 'source-child') {
              const source = doc.createElement('source');
              source.src = url;
              source.type = blobType;
              video.append(source);
            } else {
              video.src = url;
            }
            doc.querySelector('main')?.append(video);
            // Offscreen sessions defer sampling until viewport re-entry by
            // design; these scenarios assert the in-view pipeline.
            video.scrollIntoView({ block: 'center' });
            video
              .play()
              .then(() => done(null))
              .catch((err: unknown) => {
                const name = (err as { name?: unknown } | null | undefined)?.name;
                done(name === 'NotAllowedError' ? 'needs-activation' : `play() rejected: ${describe(err)}`);
              });
          };
          recorder.start();
          // Unsafe recordings must outlast the DVR presentation delay so the
          // ring buffer can warm up within a single loop of the video; the
          // turns-unsafe one is longer still so its mid-playback verdict is
          // asserted before the first loop restart.
          const durations: Record<GeneratedContent, number> = { safe: 2500, unsafe: 4000, 'turns-unsafe': 8000 };
          setTimeout(() => recorder.stop(), durations[contentMode]);
        } catch (err) {
          done(`video generation threw: ${describe(err)}`);
        }
      };

      if (contentMode === 'safe') {
        record(null);
        return;
      }
      // The gallery images are cross-origin: drawing the in-page <img> would
      // taint the canvas and captureStream() would throw. Re-load with CORS.
      const pageImage = globalThis.document.querySelector<HTMLImageElement>('main img');
      const imageSrc = pageImage?.currentSrc || pageImage?.src;
      if (!imageSrc) {
        done('no gallery image to record for the unsafe video');
        return;
      }
      const corsImage = new Image();
      corsImage.crossOrigin = 'anonymous';
      corsImage.onload = () => record(corsImage);
      corsImage.onerror = () => done('CORS load of the gallery image failed');
      corsImage.src = imageSrc;
    },
    mode,
    content,
    Selectors.TEST_VIDEO,
  );

  if (failure === 'needs-activation') {
    // Fenix enforces its own autoplay setting over profile prefs and blocks
    // script-initiated playback without user activation. A trusted WebDriver
    // click activates the document, after which play() is allowed.
    await $(Selectors.TEST_VIDEO).click();
    const retry = await browser.executeAsync((videoSelector: string, done: (failure: string | null) => void) => {
      const video = globalThis.document.querySelector<HTMLVideoElement>(videoSelector);
      if (!video) {
        done('test video missing after activation click');
        return;
      }
      video
        .play()
        .then(() => done(null))
        .catch((err: { name?: string; message?: string } | null) =>
          done(`play() after activation rejected: ${err?.name ?? 'Error'}: ${err?.message ?? ''}`),
        );
    }, Selectors.TEST_VIDEO);
    if (retry) {
      throw new Error(`Failed to start the test video — ${retry}`);
    }
  } else if (failure) {
    throw new Error(`Failed to generate or start the test video — ${failure}`);
  }
}

Then('the video is verdicted {string} within the inference timeout', async (verdict: string) => {
  const attr = `data-haramblock-processed-${verdict}`;
  await browser.waitUntil(
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
      timeoutMsg: `Video was not verdicted "${verdict}" (missing ${attr})`,
    },
  );
});

Then('I should see at least {string} video mask overlays', async (count: string) => {
  const minExpected = parseInt(count, 10);
  const canvasSelector = `${Selectors.VIDEO_SEGMENT_OVERLAY} canvas`;

  await browser.waitUntil(async () => (await countVisibleOnPage(canvasSelector)) >= minExpected, {
    timeout: INFERENCE_TIMEOUT,
    timeoutMsg: `Expected at least ${minExpected} video mask overlays, but timed out`,
  });
});

Then('I should see exactly {string} video mask overlays', async (count: string) => {
  const expected = parseInt(count, 10);
  const actual = await countVisibleOnPage(Selectors.VIDEO_SEGMENT_OVERLAY);
  expect(actual).toBe(expected);
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
  await browser.waitUntil(
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
      timeoutMsg: 'Expected the DVR canvas player to replace the native video, but timed out',
    },
  );
});

/**
 * Whole-blur watcher: records (in-page) whether the machine's whole-video blur
 * class lands on the native element after the DVR canvas has taken over. The
 * continuous DVR composites verdicts into the running presentation, so the
 * blur may appear only before takeover (adoption / warm-up cover).
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
    // BLUR_CLASS from entrypoints/content/presentation/constants.ts
    'haramblock-initial-blur',
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
