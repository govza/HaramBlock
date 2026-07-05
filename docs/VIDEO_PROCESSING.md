# Video Processing Architecture

This document describes how HaramBlock detects, samples, and masks `<video>` content. The design is
recorded in [ADR 0001](./adr/0001-video-session-state-machine.md) (session machine) and
[ADR 0002](./adr/0002-dvr-delayed-presentation.md) (DVR presentation, allow-on-impossible); the
domain vocabulary (VideoSession, Thumbnail, Frame Sample, Stale Prediction, Verdict, Fail-closed,
DVR, Presentation Delay, Inertia Window) is defined in the root [CONTEXT.md](../CONTEXT.md).

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
             ERROR (finalized as ALLOW: blur cleared, status skipped, loop stopped)

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
  pending. When analysis can never happen — a permanent capture failure (CORS-tainted canvas) or an
  unbroken failure streak — the session finalizes as ERROR: blur cleared, status `skipped`, native
  playback un-blurred. Being unable to analyze a video is not evidence that it is unsafe.
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
- **`bufferReady`** (ring spans `D`; the player inserted its canvas and hid the native element) →
  `presenting`: blur and any leftover DOM overlay are swapped out. While presenting, per-verdict
  `applyVerdict` DOM renders are suppressed — the player composites masks itself.
- **Per presented frame** (`videoDvrPlayer.ts`): look up verdicts within the Inertia Window
  (observed sampling cadence + jitter margin) around the frame's media time. Unsafe → composite the
  union of their masks (RLE-decoded once, pixelated content + destination-in); clean → draw plain;
  **no verdict → draw the live frame whole-blurred** (inference running late; presentation never
  pauses). Sampling continues at the live edge throughout.
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
