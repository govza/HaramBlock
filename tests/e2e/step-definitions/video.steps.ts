import { Given, Then, When } from '@wdio/cucumber-framework';

import { buildGalleryUrl, INFERENCE_TIMEOUT, Selectors, type GalleryModeType } from '../constants/index.js';

const getElementCount = async (selector: string): Promise<number> => {
  const elements = await $$(selector);
  return elements.length;
};

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
  const failure = await browser.executeAsync(
    (sourceMode: string, videoSelector: string, done: (failure: string | null) => void) => {
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
      try {
        const doc = globalThis.document;
        const canvas = doc.createElement('canvas');
        canvas.width = 320;
        canvas.height = 240;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          done('canvas 2d context unavailable');
          return;
        }
        let hue = 0;
        const draw = () => {
          hue = (hue + 7) % 360;
          ctx.fillStyle = `hsl(${hue}, 60%, 60%)`;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
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
          video.width = 320;
          video.height = 240;
          if (sourceMode === 'source-child') {
            const source = doc.createElement('source');
            source.src = url;
            source.type = blobType;
            video.append(source);
          } else {
            video.src = url;
          }
          doc.querySelector('main')?.append(video);
          video
            .play()
            .then(() => done(null))
            .catch((err: unknown) => {
              const name = (err as { name?: unknown } | null | undefined)?.name;
              done(name === 'NotAllowedError' ? 'needs-activation' : `play() rejected: ${describe(err)}`);
            });
        };
        recorder.start();
        setTimeout(() => recorder.stop(), 2500);
      } catch (err) {
        done(`video generation threw: ${describe(err)}`);
      }
    },
    mode,
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
});

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

  await browser.waitUntil(async () => (await getElementCount(canvasSelector)) >= minExpected, {
    timeout: INFERENCE_TIMEOUT,
    timeoutMsg: `Expected at least ${minExpected} video mask overlays, but timed out`,
  });
});

Then('I should see exactly {string} video mask overlays', async (count: string) => {
  const expected = parseInt(count, 10);
  const actual = await getElementCount(Selectors.VIDEO_SEGMENT_OVERLAY);
  expect(actual).toBe(expected);
});
