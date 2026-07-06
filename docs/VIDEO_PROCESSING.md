# Video Processing Architecture

This document describes how HaramBlock detects, samples, and masks `<video>` content — the
architecture, the vocabulary, and the design decisions behind it. General (non-video) vocabulary
(Verdict, Prediction, Fail-closed) is defined in [CONTEXT.md](CONTEXT.md).

## Vocabulary

**VideoSession**: The binding of one video element to one resolved source. Born when the pipeline
adopts a video whose source is resolved; dies when the source changes or the element is removed.
Pauses, replays, and seeks all happen inside a single VideoSession. _Avoid_: playback session,
playback run

**Thumbnail**: The first-pass input for a video's initial verdict — its poster image, or its first
frame when no poster exists. Analyzed before any playback. _Avoid_: poster (that is only one source
of a thumbnail)

**Frame Sample**: A single playback frame captured from a video and sent for inference. Frame
Samples are ordered within their VideoSession by a monotonic capture counter. _Avoid_: frame grab,
screenshot

**Stale Prediction**: A prediction that must not be applied: it belongs to a dead VideoSession, or
an older Frame Sample than one already applied. _Avoid_: late result, outdated frame

**DVR**: The delayed-presentation mode for masked playback: the video element keeps decoding while a
canvas presents buffered frames one Presentation Delay behind the live edge, compositing frame and
mask in the same draw. _Avoid_: canvas player (that is the GIF mechanism), delay overlay

**Presentation Delay (D)**: How far behind the live edge the DVR presents, sized so a frame's
verdict resolves before the frame is shown. _Avoid_: lag, latency (those describe the problem, not
the mechanism)

**Inertia Window**: The span of media time around a Frame Sample over which its verdict applies
during DVR presentation, derived from the observed sampling cadence. The video analog of GIF mask
inertia. _Avoid_: tolerance, slack

## Overview

Every video×resolved-source binding is a **VideoSession** driven by an explicit state machine:

```
ADOPTED ──capture thumbnail──► THUMBNAILING
 (blur on)                          │ verdict OR fail-closed timeout
                                    ▼
             play ┌──────────── STANDBY ◄──── sendFailed, transient (capture failed;
                  ▼               ▲            blur kept, still playable)
              SAMPLING ──pause/ended
               │  (rVFC loop; seeked → immediate one-shot sample,
               │   also fires from STANDBY while paused)
               │ MAX_CONSECUTIVE_ERRORS or sendFailed(permanent)
               ▼
             ERROR (ALLOW: blur cleared, status skipped, loop stopped;
              transient streaks retry after a cooldown, canvas taint is terminal)

any state ──source change / element removed──► DISPOSED (terminal)
```

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

## Components

| Component          | File                                                               | Role                                                                   |
| ------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Pure state machine | `entrypoints/content/video/session/machine.ts`                     | `(state, event) → (state, effects)`; no DOM, timers, or transport      |
| Registry + adapter | `entrypoints/content/video/session/registry.ts`                    | Owns live sessions, routes predictions by sessionId, executes effects  |
| Discovery          | `entrypoints/content/handlers/handleVideos.ts`                     | Routes discovered videos: blacklist styling or registry adoption       |
| Frame capture      | `entrypoints/content/video/frameCapture.ts`                        | Canvas capture, poster extraction, CORS workaround                     |
| Transport          | `entrypoints/content/communication/sender.ts`                      | `requestVideoFrameInference` (Chrome: ImageBitmap, Firefox: WebP blob) |
| Overlays           | `entrypoints/content/presentation/videoMaskOverlay.ts`             | Segmentation mask rendering (paused/standby verdicts)                  |
| DVR presenter      | `entrypoints/content/presentation/videoDvrPlayer.ts`               | Delayed masked canvas playback (playback verdicts)                     |
| DVR buffers        | `entrypoints/content/video/dvr/{frameRing,verdictTrack}.ts`        | Media-time-keyed frame ring + verdict history                          |
| Background routing | `entrypoints/background/services/inferenceOrchestrationService.ts` | Emits `IFramePrediction[]` keyed by `mediaMetadata.kind`               |

### The pure machine

`machine.ts` is a reducer with an injected notion of time: events carry `at` timestamps and timers
are requested as effects (`startTimer`/`cancelTimer`), so every behavior is unit-testable without
fake DOM or real clocks. Its effect vocabulary:

`applyBlur` · `clearBlur` · `captureThumbnail` · `sendSample{frameIndex}` · `applyVerdict` ·
`clearVerdict` · `setStatus{safe|unsafe|skipped}` · `startTimer`/`cancelTimer` · `stopTicker` ·
`startDvr`/`stopDvr` · `cleanup`

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

`registry.ts` binds each session to the real world:

- **Adoption** (`adopt`): creates the session, applies the initial blur, binds media events (`play`,
  `pause`, `ended`, `seeked`, `loadstart`, `emptied`), starts the frame ticker, and signals
  Thumbnail readiness — a `poster` is tried immediately; if it fails to load, capture fails closed
  (no frame is drawn below `HAVE_CURRENT_DATA`) and readiness is re-signaled on `loadeddata`, where
  the machine re-captures only a still verdict-less session. `preload="none"` without a poster idles
  in ADOPTED (nothing rendered, blur on) until data or playback arrives. A video whose source is not
  resolved yet is held in a registry-owned pending set: re-discovery refreshes its host settings,
  and `dispose`/`disposeAll` cancel the wait so it cannot outlive the pipeline.
- **Frame ticker**: `requestVideoFrameCallback` — fires only when a new frame is actually presented
  (stalled/paused videos produce no captures). An rAF loop gated on playback state is the fallback
  for engines without rVFC.
- **Prediction routing** (`handlePredictions`): looks up the session by `sessionId` (echoed through
  the inference pipeline in `IFrameMetadata`); unknown sessions are dropped. No DOM queries — two
  same-URL videos have independent sessions.
- **Source changes**: a `loadstart` or `emptied` whose `currentSrc` no longer matches the session
  disposes it and adopts a fresh one (immediately, or once the next source resolves). This covers
  `<source>`-children swaps, MSE attachment, and `removeAttribute('src') + load()` teardowns — the
  last fires `emptied` but never `loadstart`.
- **Sampling transport**: a failed capture or send dispatches `sendFailed`. `frameCapture.ts`
  distinguishes **permanent** failures (`SecurityError` — the canvas is CORS-tainted and can never
  be read) from **transient** ones (no frame data yet, zero dimensions): permanent finalizes the
  session as allow immediately, transient counts consecutive failures toward ERROR. Each
  capture+send round is capped by `CAPTURE_SEND_TIMEOUT_MS` (10 s, `registry.ts`) so a
  never-settling CORS-clone or poster load cannot occupy the in-flight slot forever.

### Discovery

`handleVideos.ts` is intentionally thin:

- **Blacklist policy** → blacklist styling only, no inference, no session.
- **Everything else** → `videoSessions.adopt(video, hostSettings)`. The registry itself waits out
  videos with no resolved source yet (`<video><source …>`, MSE, late `src` assignment) via a
  `loadstart` listener that keeps waiting while `currentSrc` is still empty (`srcObject` fires
  `loadstart` with no URL source), so discovery holds no state of its own.

## DVR: delayed masked presentation

DOM overlays cannot mask moving content: a verdict describes a frame displayed one inference
round-trip ago. So playback masking presents **delayed**: the `<video>` element keeps decoding (and
playing audio) while a canvas presents buffered frames a Presentation Delay `D` behind the live edge
— far enough back that every presented frame's verdict is already resolved. `D` is **adaptive**
(`dvr/delay.ts`): ~p90 of the session's observed sample→verdict round-trips plus headroom, clamped
to [1.2 s, 4 s] (1.5 s until round-trips are observed), re-read every presented frame. Inference
sample captures are capped at the active model's input size (`frameCapture.ts`, longest side,
refreshed on model switches) so the round-trip itself — and therefore `D` — stays small on HD
videos. Frame and mask are composited in the same draw, mirroring the GIF player.

Lifecycle (`machine.ts` `dvr: off | warming | presenting`, executed by the registry):

- **Unsafe verdict while playing** (or `play` on an already-masked video) → instant whole-blur +
  `startDvr`: the registry creates a `FrameRing` (rVFC captures, ≤640 px wide, ~13 fps, bounded by
  `D`+slack and a 40 MB cap) and a `VerdictTrack` (all playback verdicts, keyed by `timestampSec`).
- **`bufferReady`** (first buffered frame; the player inserted its canvas and hid the native
  element) → `presenting`: blur and any leftover DOM overlay are swapped out almost immediately.
  While the buffer is still shorter than `D`, presentation pins on the earliest buffered frame —
  masked — like a rebuffering pause (the audio delay-line fill produces a matching gap), then runs
  `D` behind the live edge. The whole-blur therefore covers only the ~100 ms until the first buffer
  capture, not a `D`-long warm-up; seeks and loop restarts get the same masked pause. While
  presenting, per-verdict `applyVerdict` DOM renders are suppressed — the player composites masks
  itself. Audio is routed through a WebAudio `DelayNode` at the same `D` (`dvr/audioDelay.ts`),
  keeping lip-sync; it falls back to live audio when the element cannot be captured (site already
  holds a `MediaElementSource`, suspended `AudioContext`, cross-origin samples WebAudio would zero
  out).
- **Per presented frame** (`videoDvrPlayer.ts`): look up verdicts within the Inertia Window
  (observed sampling cadence + jitter margin) around the frame's media time. Unsafe → composite the
  union of their masks (RLE-decoded once, pixelated content + destination-in); clean → draw plain. A
  hole in verdict coverage (latency spike) is **bridged from the neighbors** — an unsafe neighbor
  extends its masks over the hole (fail-safe), clean↔clean holes present clean — so the whole-blur
  fallback appears only under genuine verdict silence, not as a flash between masked stretches.
  Sampling continues at the live edge throughout.
- **Exit**: the clean streak (`stopDvr`, native resumes at the live edge — content jumps forward by
  `D`), pause/ended (static frame → precise DOM overlay takes back over), seek (ring discontinuity →
  flush, whole-blur, re-warm), dispose, or terminal ERROR.
- **DVR unavailable but analysis works** (buffer capture throws `SecurityError` while the CORS-clone
  sampling path still delivers verdicts): the warm-up whole-blur simply stays; the clean-streak exit
  remains reachable. Only analysis-impossible finalizes as allow.

Paused/standby verdicts never involve the DVR: a static frame has nothing to chase, so the precise
mask overlay (`videoMaskOverlay.ts`) renders it, as before.

Both video presentations (mask overlay and DVR canvas) take **element-anchored** overlay-layer slots
(`anchor: 'element'`): the slot is a fixed-positioned sibling of the video inside the site's
stacking context, so player chrome that renders above the video — controls, captions, menus — also
renders above the mask. Image/GIF masks stay in the top-layer host; the layer falls anchored slots
back to the top layer when a transformed ancestor would break fixed positioning, re-homes them there
during fullscreen when needed, and re-inserts them if framework reconciliation removes them.

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
- **Buffer every playing video pre-emptively** — tens of MB per video for the common safe case; the
  masked rebuffer already covers the warm-up gap.

Accepted consequences: masked playback costs one delayed canvas plus a hard-capped ring buffer per
session; content jumps forward by `D` when the mask clears.

## Testing

- **Unit** (`entrypoints/content/video/session/__tests__/machine.test.ts`): every machine behavior —
  adoption, timeout-at-first-send, verdict finalization, retry-then-blocked, pacing, staleness,
  hysteresis, watchdog re-blur + self-heal, lost-sample slot recovery, paused-seek one-shots,
  pause/ended, terminal allow (error streak + permanent failures), terminal disposal,
  play-preempts-thumbnail, and the DVR lifecycle (warm-up, bufferReady, pause hand-back, seek
  re-warm, dispose). `entrypoints/content/video/dvr/__tests__/` covers the FrameRing (selection,
  eviction, discontinuity flush, release) and VerdictTrack (window lookup, inertia merging,
  cadence-derived window, pruning).
- **E2E** (`tests/e2e/features/video.feature`): real-browser masking of a poster-verdicted video,
  the `<source>`-child discovery path, a clean playing video, and DVR canvas takeover on an unsafe
  playing video.

## Future enhancements

- **Global memory guards (stage 2, remaining)** — buffer caps across simultaneously-masked videos
  (per-session byte caps exist; adaptive `D` and downscaled sample captures are implemented).
- **Loop/seek verdict reuse** — verdicts are keyed by media time, so they stay valid across seeks
  and loop restarts; keeping the track (and, for loops, the ring) through the re-warm would remove
  the whole-blur window there.
- **Audio delay sync (stage 3)** — `captureStream()` + WebAudio `DelayNode` where media allows.
- **Prediction caching** — cache verdicts (not frames) keyed by `[videoSrc+timestampKey]` to skip
  redundant inference on replays/seeks. The VideoSession identity (element×source) was chosen to
  keep such a cache coherent.
- **Timeline synchronization** — reuse cached verdicts during playback.
