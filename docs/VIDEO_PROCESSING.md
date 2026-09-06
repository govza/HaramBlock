# Video Processing Architecture

This document describes how HaramBlock detects, samples, and masks `<video>` content — the
architecture, the vocabulary, and the design decisions behind it. General (non-video) vocabulary
(Verdict, Prediction, Fail-closed) is defined in [MEDIA_PROCESSING.md](MEDIA_PROCESSING.md).

## Vocabulary

**VideoSession**: The binding of one video element to one resolved source. Born when the pipeline
attaches to a video whose source is resolved; dies when the source changes or the element is
removed. Pauses, replays, and seeks all happen inside a single VideoSession. _Avoid_: playback
session, playback run

**Thumbnail**: The first-pass input for a video's initial verdict — its poster image, or its first
frame when no poster exists. Analyzed before any playback. _Avoid_: poster (that is only one source
of a thumbnail)

**Frame Sample**: A single playback frame captured from a video and sent for inference. Frame
Samples are ordered within their VideoSession by a monotonic capture counter. _Avoid_: frame grab,
screenshot

**Stale Prediction**: A prediction that must not be applied: it belongs to a dead VideoSession, or
an older Frame Sample than one already applied. _Avoid_: late result, outdated frame

**DVR**: The delayed presentation for all processed playback: from `play` onward the video element
keeps decoding while a canvas presents buffered frames one Presentation Delay behind the live edge,
compositing frame and mask in the same draw. Not a mode entered on unsafe verdicts — every playing
processed video presents through it (ADR [0001](adr/0001-continuous-dvr-and-relay-audio.md)).
_Avoid_: canvas player (that is the GIF mechanism), delay overlay, masked mode

**Presentation Delay (D)**: How far behind the live edge the DVR presents, sized so a frame's
verdict resolves before the frame is shown. Derived per DVR run from Verdict Timeline coverage and
observed round-trips, then latched until the next discontinuity. _Avoid_: lag, latency (those
describe the problem, not the mechanism)

**Verdict Timeline**: The session-lifetime, media-time-keyed verdict history. Survives DVR
stop/start, seeks, and loop restarts; live inference writes it today, the shared verdict cache will
write it tomorrow — readers cannot tell the difference. _Avoid_: verdict track (the old per-DVR-run
structure)

**Bridge Horizon**: How far ahead an upcoming unsafe verdict can be and still merge its mask
geometry into a frame's cover; further out it contributes no geometry. Between verdicts the
clean-cut rule governs: a mask spans exactly unsafe-sample → next confirmed clean verdict, and any
verdict behind covers forward at any distance (clean presents clean, unsafe keeps its own mask). The
video analog of GIF mask inertia. _Avoid_: tolerance, slack, inertia window (the old cadence-derived
bound)

## Overview

Every video×resolved-source binding is a **VideoSession** driven by an explicit state machine:

```
ATTACHED ──capture thumbnail──► THUMBNAILING
 (blur on)                          │ verdict OR fail-closed timeout
                                    ▼
             play ┌──────────── STANDBY ◄──── sendFailed, transient (capture failed;
                  ▼               ▲            blur kept, still playable)
              SAMPLING ──pause/ended (the DVR keeps presenting; see the DVR section)
               │  (rVFC loop; seeked → immediate one-shot sample,
               │   also fires from STANDBY while paused)
               │ MAX_CONSECUTIVE_ERRORS or sendFailed(permanent)
               ▼
             ERROR (ALLOW: blur cleared, status skipped, loop stopped;
              transient streaks retry after a cooldown, canvas taint is terminal)

DVR presenting ──audible audio with no obtainable route──► ERROR (terminal: status skipped, no DVR, no masking)
any state ──source change / element removed──► DISPOSED (terminal)
```

Orthogonal to the phase, the machine tracks the DVR sub-state (`dvr: off | warming | presenting`):
`play` starts it, and it survives pause, `ended`, and clean streaks — see the DVR section for its
lifecycle and exits.

Before a VideoSession exists, document-start bootstrap styles hide light-DOM videos and Reddit's
`<shreddit-player>` host. After settings arrive, a narrower discovery guard remains active for
video-enabled policies: newly inserted videos/player hosts stay hidden until discovery has applied
either blacklist styling or the attachment/pending-source blur, then
`data-haramblock-video-discovered` reveals them. This covers the interval before an asynchronously
attached shadow root can be observed without delaying the pipeline until `DOMContentLoaded`.

Key invariants:

- **Thumbnail = Frame Sample #−1.** Races between the thumbnail verdict and playback samples are
  resolved by ordering, not special cases.
- **Monotonic staleness filter.** A prediction applies only if it belongs to the live session and
  its `frameIndex` is greater than the last applied one. Late redeliveries can never clear a mask a
  newer unsafe sample applied.
- **Fail-closed with self-heal.** No verdict → the video stays blurred; but every fail-closed state
  remains exit-able by a newer sample, so recovery is automatic once inference returns.
- **Inference-impossible = allow.** Fail-closed blur applies only while a verdict is genuinely
  pending. When analysis cannot happen — a permanent capture failure (CORS-tainted canvas) or an
  unbroken transient-failure streak — the session enters ERROR: blur cleared, status `skipped`,
  native playback un-blurred. Being unable to analyze a video is not evidence that it is unsafe.
  Permanent failures are terminal; a transient streak (busy inference backend, suspended event page)
  retries after `ERROR_RETRY_COOLDOWN_MS` (30 s) — an outage must not disable protection for the
  rest of the tab's lifetime.
- **Asymmetric hysteresis.** An unsafe sample masks instantly; the mask clears only after
  `CLEAN_STREAK_TO_CLEAR` (2) consecutive clean samples.
- **Audible audio must have a delayed route** (ADRs
  [0001](adr/0001-continuous-dvr-and-relay-audio.md),
  [0002](adr/0002-direct-url-relay-audio-and-machine-owned-audio-route.md)): every video is
  attached, and when the WebAudio delay line is unavailable, **Relay Audio** plays the video's
  original URL at `currentTime − D` instead. The policy is a reducer-owned `audioRoute` axis: while
  a route is `pending`, an audible session rides a bounded-silence mute hold; protection withdraws
  (finalized `skipped`) only when the delay line is permanently unavailable, the relay element
  terminally failed to play, and the video is audibly unmuted. Permanently desynced audible audio is
  still judged worse than absent protection.
- **Withdrawn on Firefox for Android** (ADR
  [0003](adr/0003-withdraw-video-processing-on-firefox-android.md)): Gecko's opaque-surface readback
  returns empty pixels for every capture API on Android, so the `videoProcessingAvailable`
  capability flag gates discovery (`entrypoints/content/core/mediaRouting.ts`) and videos are never
  attached, hidden, or styled there. Images and GIFs are unaffected.

## Components

| Component            | File                                                                                                                | Role                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure state machine   | `entrypoints/content/video/session/machine.ts`                                                                      | `(state, event) → (state, effects)`; no DOM, timers, or transport                                                                                                                                  |
| Registry (lifecycle) | `entrypoints/content/video/session/registry.ts`                                                                     | Owns live sessions, routes predictions by sessionId, dispatch loop routing effects to the modules below                                                                                            |
| Session state        | `entrypoints/content/video/session/handle.ts`                                                                       | `SessionHandle`: per-session mutable record shared by the modules                                                                                                                                  |
| Frame sampler        | `entrypoints/content/video/session/frameSampler.ts`                                                                 | Frame ticker, thumbnail readiness, capture+send rounds, sampling bookkeeping                                                                                                                       |
| Forced presentation  | `entrypoints/content/video/session/forcedPresentation.ts`                                                           | Quick-toggle overrides: static visible/blocked presentation with no session behind it                                                                                                              |
| Viewport suspension  | `entrypoints/content/video/session/viewportSuspension.ts`                                                           | IntersectionObserver suspend/resume with grace period                                                                                                                                              |
| Presentation adapter | `entrypoints/content/video/session/presentationAdapter.ts`                                                          | Whole blur, serialized mask overlays, audio route execution, DVR run lifecycle                                                                                                                     |
| DVR run              | `entrypoints/content/video/dvr/run.ts`                                                                              | One DVR run behind five ports: store + presenter + capture drivers, latched D and its growth, budget demand; session-lifetime state in/out via carry                                               |
| Discovery            | `entrypoints/content/core/VideoProcessor.ts`                                                                        | Routes discovered videos: blacklist styling or registry attachment                                                                                                                                 |
| Frame Sample model   | `entrypoints/content/video/sampling/sample.ts`                                                                      | Separates live routing identity from reusable media-timeline identity                                                                                                                              |
| Frame capture        | `entrypoints/content/video/sampling/capture.ts`                                                                     | Canvas capture, poster extraction, CORS workaround                                                                                                                                                 |
| Transport            | `entrypoints/content/communication/sender.ts`                                                                       | `requestVideoFrameInference` (Chrome: ImageBitmap, Firefox: WebP blob)                                                                                                                             |
| Overlays             | `entrypoints/content/presentation/videoMaskOverlay.ts`                                                              | Segmentation mask rendering (paused/standby verdicts)                                                                                                                                              |
| DVR presenter        | `entrypoints/content/presentation/videoDvrPlayer.ts`                                                                | Delayed masked canvas playback (playback verdicts)                                                                                                                                                 |
| DVR buffers          | `entrypoints/content/video/dvr/{frameStore,rawFrameRing,encodedFrameRing,decodedFrameConverter,verdictTimeline}.ts` | Media-time-keyed frame store (raw ImageBitmap ring or WebCodecs-encoded ring behind one `DvrFrameStore` interface, Firefox off-thread decoded-frame conversion) + session-lifetime verdict history |
| DVR capture tap      | `entrypoints/content/video/dvr/captureTap.ts`                                                                       | Full-rate ring capture via `captureStream` + `MediaStreamTrackProcessor`; rVFC ticks are the fallback                                                                                              |
| DVR store selection  | `entrypoints/content/video/dvr/frameStoreFactory.ts`                                                                | Per-DVR-run capability probe, encoded-session concurrency cap, mid-run raw fallback on codec errors                                                                                                |
| DVR memory budget    | `entrypoints/content/video/dvr/ringBudget.ts`                                                                       | Global backend-tiered byte budget with a shared quality-degradation ladder                                                                                                                         |
| DVR audio delay      | `entrypoints/content/video/dvr/audioDelay.ts`                                                                       | WebAudio DelayNode routing + the delayability check                                                                                                                                                |
| DVR relay audio      | `entrypoints/content/video/dvr/relayAudio.ts`                                                                       | Delayed audio for origin-tainted sources: hidden `<audio>` on the original URL at `currentTime − D`; also owns the pending-route mute hold (ADR 0002)                                              |
| DVR drain clock      | `entrypoints/content/video/dvr/drain.ts`                                                                            | Plays out the buffered tail at 1x after `ended`, then pins the final frame                                                                                                                         |
| Background routing   | `entrypoints/background/services/inferenceOrchestrationService.ts`                                                  | Emits `IFramePrediction[]` keyed by `mediaMetadata.kind`                                                                                                                                           |

### The pure machine

`machine.ts` is a reducer with an injected notion of time: events carry `at` timestamps and timers
are requested as effects (`startTimer`/`cancelTimer`), so every behavior is unit-testable without
fake DOM or real clocks. Its effect vocabulary:

`applyBlur` · `clearBlur` · `captureThumbnail` · `sendSample{frameIndex,timestampSec}` ·
`applyVerdict` · `clearVerdict` · `setStatus{safe|unsafe|skipped}` · `startTimer`/`cancelTimer` ·
`stopTicker` · `startDvr`/`stopDvr` · `cleanup`

Tuning constants (all in `machine.ts`):

| Constant                 | Value  | Meaning                                                                                    |
| ------------------------ | ------ | ------------------------------------------------------------------------------------------ |
| `THUMBNAIL_TIMEOUT_MS`   | 10 000 | Fail-closed clock, started at the **first actual send**; one retry, then finalized blocked |
| `SAMPLE_FLOOR_MS`        | 250    | Minimum interval between Frame Sample sends (~4 fps ceiling)                               |
| `SAMPLE_TIMEOUT_MS`      | 3 000  | Frees the single in-flight slot when a verdict is lost                                     |
| `WATCHDOG_MS`            | 5 000  | Mid-playback verdict silence → whole-video re-blur                                         |
| `CLEAN_STREAK_TO_CLEAR`  | 2      | Consecutive clean samples required to lift a mask                                          |
| `MAX_CONSECUTIVE_ERRORS` | 10     | Transient capture/send failures before ERROR (finalized as allow)                          |

### The registry / DOM adapter

The adapter side is four modules sharing a per-session `SessionHandle` (`handle.ts`): `registry.ts`
owns lifecycle and the dispatch loop, and routes each machine effect to the module that executes it
— `frameSampler.ts` (capture and transport), `viewportSuspension.ts` (offscreen suspend/resume), and
`presentationAdapter.ts` (blur, overlays, DVR). Together they bind each session to the real world:

- **Attachment** (`attach`): creates the session, applies the initial blur, binds media events
  (`play`, `pause`, `ended`, `seeked`, `loadstart`, `emptied`), starts the frame ticker, and signals
  Thumbnail readiness — a `poster` is tried immediately; if it fails to load, capture fails closed
  (no frame is drawn below `HAVE_CURRENT_DATA`) and readiness is re-signaled on `loadeddata`, where
  the machine re-captures only a still verdict-less session. `preload="none"` without a poster idles
  in ATTACHED (nothing rendered, blur on) until data or playback arrives. A video whose source is
  not resolved yet is held in a registry-owned pending set: re-discovery refreshes its host
  settings, and `dispose`/`disposeAll` cancel the wait so it cannot outlive the pipeline.
- **Frame ticker**: `requestVideoFrameCallback` — fires only when a new frame is actually presented
  (stalled/paused videos produce no captures). Its `mediaTime` is carried by the machine's
  `frameAvailable` event into the `sendSample` effect, so async capture and transport never reread a
  later `video.currentTime`. Firefox keeps counting `mediaTime` across a native loop (past the
  duration), so the ticker folds it back by whole durations (`foldLoopedMediaTime`) before the DVR
  ring keys on it. An rAF loop gated on playback state is the fallback for engines without rVFC.
- **Viewport lifecycle**: a shared `IntersectionObserver` keeps sessions within 400 px of the
  viewport active. Scrolled-away videos retain their verdict state but stop their frame ticker and
  release any DVR player, audio delay, and frame ring. Leaving the margin only suspends after a 1 s
  grace period (`VIDEO_SUSPEND_GRACE_MS`) so boundary flapping in a virtualized feed cannot thrash
  the DVR; re-entry resumes immediately. Boxless players (`display:none` behind a poster overlay)
  never intersect and are exempt — their thumbnail still captures eagerly so a reveal finds its
  verdict ready. Thumbnail capture is otherwise deferred while offscreen and replayed on re-entry
  whenever the session is still verdict-less; a playback sample deflected during suspension marks
  the session for a re-sample, which a paused re-entry fires as a synthetic seek (a playing one
  re-enters sampling anyway). A suspend also bumps a per-session capture epoch so a capture that was
  in flight across it can never send its stale frame after resume. Re-entry restarts sampling and
  playback presentation under the existing fail-closed blur. This is essential for virtualized feeds
  such as Reddit, whose old autoplay players often remain connected to the DOM after scrolling away.
- **Result routing** (`handleResults`): looks up the session by `sessionId` (echoed through the
  inference pipeline in `IFrameMetadata`); unknown sessions are dropped. No DOM queries — two
  same-URL videos have independent sessions. An inference-error result dispatches transient
  `sendFailed`, freeing the in-flight slot immediately instead of waiting out the sample timeout.
- **Source changes**: a `loadstart` or `emptied` whose URL or `srcObject` no longer matches the
  session disposes it and attaches a fresh one (immediately, or once the next source resolves). This
  covers `<source>`-children swaps, MSE attachment, object-backed streams, and
  `removeAttribute('src') + load()` teardowns — the last fires `emptied` but never `loadstart`.
- **Sampling transport**: a failed capture or send dispatches `sendFailed`, as does an
  inference-error reply from the background. `sampling/capture.ts` distinguishes **permanent**
  failures (`SecurityError` — the canvas is CORS-tainted and can never be read) from **transient**
  ones (no frame data yet, zero dimensions): permanent finalizes the session as allow immediately,
  transient counts consecutive failures toward ERROR. Each capture+send round is capped by
  `CAPTURE_SEND_TIMEOUT_MS` (10 s, `frameSampler.ts`) so a never-settling CORS-clone or poster load
  cannot occupy the in-flight slot forever. Capture stages have shorter internal deadlines as well:
  poster load/bitmap creation, CORS clone load/seek, and frame bitmap creation fail independently. A
  CORS clone mirrors active playback after its first exact seek, avoiding a network-backed random
  seek for every sample; every draw still verifies the selected media time. When the CORS clone
  fails (server sends no CORS headers), a **Relay Fetch** tier engages before giving up: the
  background fetches the media bytes CORS-exempt (`mediaFetchService.ts`, dedicated
  `MEDIA_DOWNLOAD_MAX_BYTES` cap and an abort-based whole-download timeout), and the clone plays
  them from a page-origin `blob:` URL so the canvas stays origin-clean. Only when Relay Fetch also
  fails (opaque error, over budget) does the source stay tainted and the permanent-failure path
  finalize the session as allow. Firefox clone seeks resolve from either media events or observable
  ready-state/time convergence, and initial success is reported only after that convergence. A
  stalled cached clone is evicted so later samples can recreate it instead of timing out forever.
  Video thumbnails use queue priority 20 and playback samples priority 10, below visible images
  (30), so autoplay cannot indefinitely hold newly discovered page images behind its frame backlog.
  The background retains at most one not-yet-started playback frame per `sessionId`: a newer frame
  aborts and releases the older queued bitmap, while a frame arriving out of order (the cancel RPC
  and frame payloads ride different transports) is dropped rather than replacing a fresher queued
  one. Suspending or disposing a session cancels that queued frame explicitly (skipped when the
  session never sent a playback frame — the cancel would be a guaranteed no-op RPC); inference
  already running is allowed to finish and its session-routed result is harmless if the session has
  gone away. Firefox discovers some canvas taint only when its WebP transfer calls
  `OffscreenCanvas.convertToBlob()` (`createImageBitmap()` may still succeed); that
  write-only-canvas exception is also permanent, so the session stops retrying immediately.

Each Frame Sample has two deliberately separate identities:

- **Live routing** — `sessionId + frameIndex`; used for staleness and delivery to the current
  VideoSession, never suitable as a persistent key.
- **Media timeline** — `videoUrl + timestampSec`; stable across VideoSessions for the same
  URL-backed media and the starting point for future verdict caching. Object-backed streams use a
  session-local, non-cacheable `videoUrl` label. A `CapturedFrameSample` attaches pixels, source
  dimensions, and capture time to both identities. No video verdicts are persisted yet.

Paused seeks retain their selected `timestampSec` while another sample is in flight. The cached CORS
decoder also waits for its seek to that timestamp to complete before drawing, keeping the timeline
identity attached to the pixels it actually supplies.

### Discovery

`VideoProcessor` (`core/VideoProcessor.ts`) is intentionally thin:

- **Blacklist policy** → blacklist styling only, no inference, no session.
- **Everything else** → `videoSessions.attach(video, hostSettings)`. The registry itself waits out
  videos with no resolved source yet (`<video><source …>`, MSE, late `src` assignment) via a
  `loadstart` listener; a non-null `srcObject` is itself a resolved source even though it has no
  URL, so discovery holds no state of its own. The wait is blurred: a src-less video still displays
  its poster, and attachment keeps the blur — there is no unprotected gap between discovery and
  ATTACHED.

## DVR: continuous delayed presentation

DOM overlays cannot mask moving content: a verdict describes a frame displayed one inference
round-trip ago. So processed playback presents **delayed**: the `<video>` element keeps decoding
while a canvas presents buffered frames a Presentation Delay `D` behind the live edge — far enough
back that every presented frame's verdict is already resolved. The DVR is **continuous** (ADR
[0001](adr/0001-continuous-dvr-and-relay-audio.md)): it starts on `play`, before any verdict exists,
and runs for the rest of playback. Because the delayed canvas and delayed audio are already in place
when an unsafe verdict lands, the verdict composites into the running presentation with no visible
or audible mode switch, and a clean streak clears masks without ever leaving the DVR — the
engage-gap and release-jump glitches of the old enter-on-unsafe design cannot occur.

`D` is **derived per DVR run and latched** (`dvr/delay.ts`, `deriveDvrDelayMs`): at every DVR
(re)start — including the stopDvr/startDvr pair a seek re-warm goes through — the Verdict Timeline
is consulted first. A range whose coverage extends at least 2×the adaptive estimate ahead needs no
inference wait and gets `COVERED_DVR_DELAY_MS` (300 ms — replays and re-visited seeks all but skip
the warm-up pause); an uncovered range gets the adaptive estimate: ~p90 of the session's observed
sample→verdict round-trips plus headroom, clamped to [1.2 s, 4 s] (1.5 s until round-trips are
observed). Within a continuous playback run D **only ever grows**: each verdict re-derives it, and a
larger result is adopted (`raiseDelayIfLagging`) so a run that latched too small a D — no
round-trips observed yet at the first `play`, or a covered range whose coverage ran out — does not
present verdict-less, whole-blurred frames for the rest of the run. Growing D slides presentation
further behind the live edge (repeating a moment of already-seen video, within the ring horizon); it
never shrinks, so presentation never jumps forward into content no verdict describes. A genuinely
covered range still re-derives the small covered D, so it is left alone. Inference sample captures
are capped at the active model's input size (`sampling/capture.ts`, longest side, refreshed on model
switches) so the round-trip itself — and therefore `D` — stays small on HD videos. Frame and mask
are composited in the same draw, mirroring the GIF player.

Both lag sources feed the same let-D-grow path, and lag that D cannot absorb becomes a machine
event. A **store stall** — the frame store missing `frameAt` on a media time it covers, exposed as
the monotonic `coveredMisses()` counter on the store contract (the raw ring never advances it) — is
read on the per-verdict sync and raises D, so a slow store buys itself headroom by sliding further
behind the live edge instead of pinning a frozen frame. "Covers" reaches to the newest _captured_
time, not just the newest encoded chunk: an encode pipeline running behind the live edge starves
presentation exactly like a slow decoder. The raise is the larger of a fixed step and the measured
capture→presentable lag, and each DVR run starts with a one-delta holdoff so the decoder's warm-up
priming misses never count. Stall-driven raises also persist as a session-lifetime floor under the
derived D (`dvrStallFloorSec`): a store that proved it cannot serve the small covered D must not
re-limp through the same raises after every seek/loop re-warm. An **analysis underrun** — the
derived D clamped at its ceiling while coverage ahead of the playhead still trails the latched D
(`isAnalysisUnderrun`), sustained over `UNDERRUN_VERDICT_STREAK` consecutive verdicts — dispatches
`analysisUnderrun` to the machine: the first widens the sampling floor to `RELIEVED_SAMPLE_FLOOR_MS`
(fewer samples relieve inference pressure), and a second sustained underrun after relief demotes the
session out of the DVR terminally — this machine cannot analyze fast enough, and
inference-impossible is allow, not block.

Lifecycle (`machine.ts` `dvr: off | warming | presenting`, executed by the presentation adapter):

- **`play`** → `startDvr`: the presentation adapter derives and latches `D`, registers the session's
  demand with the global ring budget, and creates a `DvrFrameStore` via the frame-store factory: a
  raw ImageBitmap ring immediately (capped at ~30 fps by the budget ladder's tier), upgraded
  in-place to the WebCodecs-encoded ring when the async WebCodecs probe passes (`prefer-hardware` on
  Chrome; `no-preference` on Firefox, whose release builds expose no hardware encoder and run the
  software encoder off the main thread in a media process) (native-resolution `VideoFrame` captures
  at the source's **native frame rate**, bitrate-shaped demand, ~50-100x smaller; the upgrade flush
  re-warms like a seek). On Firefox the encoded ring hands every decoded `VideoFrame` to a blob
  worker that draws it onto an `OffscreenCanvas` and returns an `ImageBitmap`
  (`dvr/decodedFrameConverter.ts`): Gecko has no GPU path from a decoded frame to a canvas, so any
  `drawImage`, `createImageBitmap`, or WebGL upload of one converts its YUV planes to RGB on the
  calling thread (~16 ms per 1080p frame on the presenter's rAF tick, ~2 ms once it draws the
  worker's bitmap instead; the conversion costs ~30 ms of extra decode-ahead latency). Conversions
  in flight count against the decode lookahead, and a conversion landing after a rewarm or
  discontinuity is discarded. Content scripts can only spawn blob/data workers, which a page CSP may
  block — a `worker-src`/`script-src` without `blob:` fails the worker asynchronously (the converter
  strands the frames in flight and passes later frames through), and Trusted Types enforcement
  (YouTube: `require-trusted-types-for 'script'`) makes the `Worker` constructor throw outright, so
  the ring runs without a converter (`dvr.frame_converter.unavailable`). No workaround exists on
  such pages: a `moz-extension:` worker URL never loads from a content script, an extension-origin
  iframe (which can host workers) never receives a transferred `VideoFrame`, and `VideoFrame.copyTo`
  does the same readback on the calling thread as a draw. Firefox therefore also asks the decoder
  for `prefer-software`: a hardware-decoded frame is read back from the GPU before its colour
  conversion (~15 ms per 1080p draw), a software-decoded one only converted (~7 ms), and the
  software H.264 decoder runs off the main thread either way. Chrome draws a decoded frame in well
  under a millisecond and runs without a converter. Ring capture is driven by a full-rate **capture
  tap** (`dvr/captureTap.ts`: `captureStream()` + `MediaStreamTrackProcessor`, every decoded frame,
  keyed by `video.currentTime` at delivery) with the rVFC tick as the standing fallback — rVFC alone
  misses frames on 60 fps sources (~43/60 observed), and it resumes capturing automatically whenever
  the tap is absent or stalls (media-time liveness window, no explicit health protocol). The intent
  split: **inference samples stay small** (model-input-sized, ~4 fps, `sampling/capture.ts`), while
  **presented frames are full video frames at the native rate** when the encoded store carries the
  ring. The active path is exposed as `data-hb-dvr-store="raw|encoded"` on the video element; a
  codec error swaps back to a fresh raw ring and marks the session webcodecs-ineligible. The warm-up
  is whole-blurred: the DOM overlay of an already-masked session would lag the moving content, a
  verdict-less session simply keeps its attachment blur, and a safe-verdicted session is covered too
  because the pinned earliest frame is no cover until the player has captured a frame and injected
  its canvas — the native element renders live for those first ticks. `bufferReady` lifts it as soon
  as the canvas takes over, and a clean playback verdict is the escape when capture never succeeds.
  The one uncovered case is a deliberately allowed session (status `skipped`), whose finalize
  cleared the blur on purpose. The session's Verdict Timeline (every playback verdict, keyed by
  `timestampSec`) already exists on the handle and is shared with the player read-only.
- **`bufferReady`** (first buffered frame; the player inserted its canvas and hid the native
  element) → `presenting`: blur and any leftover DOM overlay are swapped out. While the buffer is
  still shorter than `D`, presentation pins on the earliest buffered frame — whole-blurred until a
  playback verdict covers it — like a rebuffering pause (the audio delay-line fill produces a
  matching gap), then runs `D` behind the live edge. While presenting, per-verdict `applyVerdict`
  DOM renders are suppressed — the player composites masks itself. Audio is routed through a
  WebAudio `DelayNode` at the same `D` (`dvr/audioDelay.ts`), keeping lip-sync; a permanent capture
  failure withdraws protection entirely (see the audio precondition below).
- **Unsafe verdict while playing**: no transition — the verdict lands in the Verdict Timeline and
  the already-running presentation composites its masks `D` later. Only a DVR still `warming`
  (canvas not yet presenting) gets an interim whole-blur cover.
- **Per presented frame** (`videoDvrPlayer.ts`): the **clean-cut rule** — a mask exists exactly on
  the span from its unsafe sample's timestamp to the next clean verdict's timestamp. Never before
  the unsafe sample (no pre-roll), and never after a clean verdict that a following clean verdict
  confirms; because presentation runs `D` behind the live edge, that confirming verdict has normally
  already arrived by the time the clean frame is presented, so the streak costs no extra trail. An
  unconfirmed clean verdict (nothing after it yet, or an unsafe verdict right after) does not cut —
  the mask holds, fail closed. Frames between two unsafe samples composite the union of both
  bounding masks (RLE-decoded once, pixelated content + destination-in; the pixelated copy is
  sampled from the already-drawn base canvas, never from the frame, which on Firefox would pay its
  YUV conversion a second time) — inertia over the unknown motion in between; an upcoming unsafe
  verdict beyond the Bridge Horizon contributes no geometry. **Any verdict behind covers forward at
  any distance** (closest verdict wins): a clean one presents clean (no mask geometry to go stale),
  an unsafe one keeps masking with its own geometry — masked content beats hiding the whole frame —
  so a paused frame or a coverage hole after a seek presents instead of whole-blurring. There is no
  fail-open exception for a session the machine already cleared: the clearing verdict there is the
  Thumbnail, which describes the poster and carries no media time, so it must never present playback
  frames it does not describe — that let Shorts' unsafe first frame show unmasked for a full
  round-trip. Only genuine verdict silence — no verdict behind at all, including frames that precede
  an upcoming unsafe sample (never pre-rolled) — whole-blurs (the cost is a short blur over the
  pinned frame on a clean video's first play; re-warms into covered ranges present clean
  immediately). Lookups binary-search the timestamp-ordered timeline and read the bounding
  neighbors, so per-tick cost stays constant rather than growing with the session. Sampling
  continues at the live edge throughout.
- **Clean streak while presenting**: clears the logical mask/status, nothing else — the DVR is the
  permanent presentation for the rest of playback. Clean frames draw plainly via the Verdict
  Timeline; no live-edge jump, no re-warm flash when detections are intermittent.
- **Pause**: never exits the DVR. The media clock freezes, so the canvas holds the delayed frame the
  viewer was actually seeing; `play` resumes presentation without a re-warm. The sampling
  bookkeeping winds down, and the audio route is dropped (`releaseAudioRoute`) and re-engaged on
  resume (`audioRoute` back to `pending` + `engageAudioRoute`): a `DelayNode` runs on the audio
  clock, not the media clock, so a line left attached would drain its buffered `D` seconds of speech
  over the frozen frame. Resume therefore costs `D` seconds of silence while the fresh line refills
  — the buffered tail is gone either way. The exception is the pause Chrome fires just before
  `ended` (`atEnd` on the event): there the route is kept, because its buffered audio is the
  soundtrack of the picture tail the drain is about to replay — dropping it would play every natural
  ending mute.
- **`ended`** → `drainDvr`: the presenter switches to a drain clock (`dvr/drain.ts`) that advances
  the presented media time at 1x wall rate from where presentation froze to the newest buffered
  frame, then holds that final frame — the ending plays out ~`D` late instead of being cut off. A
  DVR still `warming` at `ended` has no tail to drain and `bufferReady` can never fire, so it hands
  back to the DOM overlay instead of latching its warm-up blur forever.
- **Seek**: ring discontinuity → flush and re-warm (stopDvr/startDvr) with a freshly derived `D` —
  the store itself treats a backwards capture key within `STALE_FRAME_TOLERANCE_SEC` (0.5 s) as a
  re-delivered stale frame (dropped, buffer kept) and only flushes on a larger step — small when the
  seek lands in a range the timeline already covers, so re-visited content barely pauses. The
  warm-up cover is re-established under the same fail-closed rule: whole-blur while masked or
  verdict-pending; a resumed skipped session stays deliberately uncovered.
- **Exits**: viewport suspension (offscreen sessions must return their ring memory; a masked session
  hands back to the precise DOM overlay before the native element is revealed), disposal, terminal
  ERROR, source change, and the undelayable-audio demotion. Pause, `ended`, and clean streaks are
  **not** exits. The Verdict Timeline itself survives every exit; only the ring and player are
  discarded.
- **DVR unavailable but analysis works** (buffer capture throws `SecurityError` while the CORS-clone
  sampling path still delivers verdicts): the warm-up whole-blur simply stays while masked or
  verdict-pending; the clean-streak `clearBlur` is the un-blur escape, since `bufferReady` can never
  lift the blur there. Only analysis-impossible finalizes as allow.

The precise mask overlay (`videoMaskOverlay.ts`) still renders static-frame verdicts whenever the
DVR is off: before first play, and after a viewport suspension hands the element back. While the DVR
is warming or presenting, it owns masking even for a paused frame.

### Audio routing

Delayed picture with live audio means permanent lip-sync desync, and switching audio routes
mid-playback is audible — so audible audio must ride a delayed route while the DVR presents (ADRs
[0001](adr/0001-continuous-dvr-and-relay-audio.md),
[0002](adr/0002-direct-url-relay-audio-and-machine-owned-audio-route.md)). The policy lives in the
reducer as the `audioRoute` axis (`none | pending | delayLine | relay`): `bufferReady`, resume, and
every verdict while `pending` emit `engageAudioRoute`; the adapter reports one `audioEngageResult`
per attempt, and the reducer alone decides engaged/retry/withdraw. An engage tries, in order:

- **WebAudio delay line** (`dvr/audioDelay.ts`): `createMediaElementSource` → `DelayNode` at `D`.
  Only for delayable sources (`isAudioDelayable`) — WebAudio zeroes origin-tainted samples.
- **Relay Audio** (`dvr/relayAudio.ts`): for undelayable sources, a hidden `<audio>` plays the
  video's **original URL** at `currentTime − D` (media playback needs no CORS — no blob, no
  download); the page element is silenced (`volume = 0`, so site mute writes stay observable) while
  engaged, the site's muted/volume intent mirrored onto the relay element (async-safe pending-writes
  counter) and restored on release. Drift syncs every 500 ms: hard seek beyond 0.25 s, rate nudge
  inside it; the DVR drain keeps the tail playing `D` more wall-clock seconds.
- **Pending and audible** → `holdPageMute`: bounded silence (not desynced live audio, not lost
  protection) while the route comes up — covering both the relay element's buffering window and the
  deferred-`AudioContext` pre-gesture window.
- **No route obtainable and audibly unmuted** (delay line permanently unavailable AND the relay
  element terminally failed) → finalize `skipped`: DVR and masking torn down, native playback
  restored with the site's audio intent. A muted video has no audio to desync: it stays protected
  and `pending`; the unmute moment (raw `unmuted`/`muted` intent events) re-holds and retries.
- **Transient outcomes** (suspended `AudioContext` awaiting its gesture, relay element buffering
  timeout or recoverable media error) report `deferred`: the route stays `pending` and the next
  verdict retries. The retry is not optional: a deferred engage left alone would present delayed
  picture against live audio, the same permanent desync this routing exists to prevent.

### Memory: the global ring budget

All active rings share one byte budget (`dvr/ringBudget.ts`), tiered by the active inference backend
as a hardware proxy — WebGPU → 1 GB global / 768 MB per session, WASM → 128 MB for both (the WASM
tier fails safe until the backend, known in the background at model load, arrives with host
settings). The ladder's full tier has **no width ceiling**: capture is capped by the rendered size
in device pixels (up to native), so an embedded player buffers cheaply while a fullscreen 1080p one
captures at full resolution — pixels the viewer cannot see are wasted bytes, everything they can see
is captured when the byte budget allows. When the projected demand of all registered sessions
exceeds the budget, every session degrades down a shared ladder — capture width ∞ (display-capped) →
1280 → 640 → 480 → 320 px, then capture rate (raw ~30 → ~15 fps; encoded native → ~30 fps — its byte
demand is bitrate-shaped, so native rate costs no ring memory), then ring horizon shrink — and
recovers in reverse as sessions release (suspension, disposal). Demand is projected from registered
geometry rather than measured from live ring bytes, so degradation and recovery are immediate; a
session that started its DVR before metadata landed re-registers as soon as the real frame geometry
arrives, so the projection cannot stay stuck on the fallback 16:9 estimate — and a materially
resized player (embedded → fullscreen crosses the 1.25× hysteresis) re-registers its display-derived
cap the same way. Per-session, the ring stays bounded by `D`+slack, the backend-tiered session cap,
and the budget-derived capture scale (`dvr/captureScale.ts`): the largest capture size — up to
min(display size, the ladder's width ceiling) — whose frames still let the ring span `D`+slack
inside the byte cap. On Firefox the raw ring's ceiling is additionally held at 960 px
(`FIREFOX_RAW_CAPTURE_MAX_WIDTH`): a native-width raw ring holds ~570 MB of RGBA in the content
process (200 MB at 960 px), and Firefox's `drawImage` from a video is source-bound (~18 ms per frame
at either width), so the ceiling buys memory headroom rather than main-thread time; the encoded ring
captures at native resolution regardless (its present cost is moved off the main thread by the
decoded-frame converter instead). A live ring never shrinks below its latched `D`, or presentation
would strand on the warm-up frame. The presenter's base canvas backs at device-pixel resolution
(capped at the buffered frame's own width) and draws in whole device pixels through the identity
transform (`toDevicePixels`), so a frame that matches the backing store is a 1:1 blit; on Firefox
both presenter canvases are created with `willReadFrequently` so that blit stays a memcpy into a
software canvas instead of a texture upload. Only the mask canvas keeps `image-rendering: pixelated`
(its blockiness is the masking effect itself).

Both video presentations (mask overlay and DVR canvas) are **DOM-injected** overlay divs homed as
the video's next sibling with the video's own z-index (see
[MEDIA_PROCESSING.md](MEDIA_PROCESSING.md)), so player chrome that renders above the video —
controls, captions, menus — also renders above the mask. (A `+1` z-index in an ancestor container
out-stacked `z-index: auto` chrome layers on Facebook Reels; fixed-position videos still use
container injection.) The mask overlay uses the shared renderer machinery (parent-aware
`ResizeObserver`, mutation-batch classification, re-homing); the DVR presenter syncs its geometry
per tick of its own draw loop instead — including re-homing itself when the site re-parents the
player (YouTube's watch-page boot).

**Shadow-DOM players** (Reddit's `<shreddit-player>`) work end to end: discovery pierces open shadow
roots — including roots attached long after insertion by async-loaded components (see `DomObserver`
in [MEDIA_PROCESSING.md](MEDIA_PROCESSING.md)) — and both presentations inject via
`resolveInjectionContext`, which handles the video being a direct child of the shadow root
(`parentElement` is null there: the overlay lives inside the shadow tree, positioned against the
shadow host). Closed shadow roots remain out of reach.

## Processed status attributes

Set by the machine's `setStatus` effect (contract kept from the previous pipeline):

- `data-haramblock-processed-safe` — no unsafe content in the latest applied verdict
- `data-haramblock-processed-unsafe` — unsafe content detected (or fail-closed blocked)
- `data-haramblock-processed-skipped` — processing impossible (terminal ERROR: video plays
  un-blurred)

Exactly one is present after finalization; all are removed on disposal. The initial blur uses the
shared `haramblock-initial-blur` class.

## Design rationale

Condensed from the two architecture decisions this pipeline is built on (issue #53, PRs #69/#70).

### A pure per-session state machine, routed by session, fail-closed

Issue #53 reported the old pipeline as unreliable: `<source>`-children and `preload="none"` videos
were never picked up, late predictions could clear a mask a newer unsafe frame had just applied,
seeks left stale masks, and a dead service worker left videos blurred forever (or unprotected
mid-playback). These were consequences of the design — implicit state scattered across `dataset`
flags, a rAF/token-bucket loop paced by a global timing event, URL-based DOM queries for result
routing — so it was rearchitected rather than patched into the VideoSession machine described above.

Considered and rejected:

- **Patching the existing loop** — each symptom had a point fix, but the implicit-state design kept
  regenerating new races.
- **Session = playback run or seek-delimited epoch** — per-run identities orphan in-flight
  predictions and fragment any future prediction cache; monotonic frameIndex ordering makes seek
  races benign without discarding valid results.
- **URL-based routing with added validation** — same-URL videos sharing verdicts is a correctness
  hazard, and routing stays coupled to `dataset` attributes.
- **Symmetric temporal smoothing** — requiring N positive samples before masking shows unsafe frames
  while "warming up", contradicting the protection-first stance.

Accepted consequence: same-URL videos on one page each run their own session and duplicate inference
cost; routing correctness wins.

### DVR delayed presentation; allow on inference-impossible

The session machine made masking reliable but not synchronous: a DOM overlay applied "now" describes
a frame displayed one inference round-trip ago, so on a playing video the mask chases the content
and unsafe regions leak between samples. The GIF pipeline avoids this by deferring playback until
verdicts exist, compositing frame + mask atomically, and stretching each verdict with inertia — the
DVR gives video those same three properties (see the DVR section above).

Considered and rejected:

- **Predictive overlays** (extrapolate mask motion) — guessing where unsafe content moved is exactly
  the failure mode the pipeline exists to prevent.
- **Pause playback until verdicts arrive** (the GIF model literally) — videos are long and streamed;
  freezing playback per sample is unusable, and sites fight scripted pauses.
- **Block on inference-impossible** — permanently blurring everything the pipeline cannot read (most
  cross-origin videos without CORS headers) breaks far more legitimate content than it protects;
  hence ERROR = allow.
- **Buffer every playing video pre-emptively** — rejected here for its per-video memory cost in the
  common safe case, then **adopted after all** by ADR
  [0001](adr/0001-continuous-dvr-and-relay-audio.md): the engage/release switches of
  DVR-only-while-masked proved worse than the cost, which the global backend-tiered ring budget now
  bounds. This bullet is kept as history; the ADR supersedes it.

Accepted consequences (per ADR 0001): every processed video pays ~`D` of pinned start, is watched
`D` behind the live edge (including live streams), and costs capture/canvas CPU plus bounded ring
memory while playing; the seek bar reads `D` ahead of the picture; endings complete ~`D` late; sites
where audio cannot be delayed receive no protection at all.

## Testing

- **Unit** (`entrypoints/content/video/session/__tests__/machine.test.ts`): every machine behavior —
  attachment, timeout-at-first-send, verdict finalization, retry-then-blocked, pacing, staleness,
  hysteresis, watchdog re-blur + self-heal, lost-sample slot recovery, paused-seek one-shots,
  terminal allow (error streak + permanent failures), terminal disposal, play-preempts-thumbnail,
  and the continuous-DVR lifecycle (start on play, warm-up cover rules, bufferReady, clean streak
  staying in the DVR, pause hold, ended drain, seek re-warm, suspension hand-back, undelayable-audio
  demotion, dispose). `entrypoints/content/video/dvr/__tests__/` covers the shared `DvrFrameStore`
  contract run against both the raw and (mock-codec) encoded rings (selection, eviction,
  discontinuity flush, release), encoded-ring specifics (GOP keyframing, decode-ahead, backpressure
  drops, keyframe re-warm, codec-error teardown), the store factory's selection matrix (probe ×
  concurrency cap × prior error × flag), the VerdictTimeline (window lookup, inertia merging,
  coverage-ahead, entry cap), coverage-derived delay derivation, the budget-derived capture scale,
  the global ring budget's degradation ladder, the drain clock, and the presented-fps simulation
  harness parameterized over both stores.
- **E2E** (`tests/e2e/features/video.feature`): real-browser masking of a poster-verdicted video,
  the `<source>`-child discovery path, DVR canvas takeover on a clean playing video, and an unsafe
  verdict landing mid-playback compositing into the running DVR without a whole-blur flash.

## Future enhancements

- **Loop verdict+ring reuse** — the Verdict Timeline already survives seeks and loop restarts
  (covered re-warms derive a small `D`); for loops specifically, keeping the ring too would remove
  even the short covered re-buffer.
- **Prediction caching and persistence** — persist verdicts (not frames) from the reusable
  `videoUrl + timestampSec` side of Frame Sample identity, augmented with media revision and model
  identity. Cache hits must be rebound to the requesting `sessionId + frameIndex`; those routing
  fields must never become persistent keys.
- **Timeline synchronization** — seed the session's Verdict Timeline from cached timeline verdicts
  and infer only uncovered ranges during playback, seek, and replay. With coverage-derived `D`
  already in place, a fully cached video plays at `COVERED_DVR_DELAY_MS` from the first unsafe
  verdict.
