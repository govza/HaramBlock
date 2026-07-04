# Video Processing Architecture

This document describes how HaramBlock detects, samples, and masks `<video>` content. The design is
recorded in [ADR 0001](./adr/0001-video-session-state-machine.md); the domain vocabulary
(VideoSession, Thumbnail, Frame Sample, Stale Prediction, Verdict, Fail-closed) is defined in the
root [CONTEXT.md](../CONTEXT.md).

## Overview

Every video×resolved-source binding is a **VideoSession** driven by an explicit state machine:

```
ADOPTED ──capture thumbnail──► THUMBNAILING
 (blur on)                          │ verdict OR fail-closed timeout
                                    ▼
             play ┌──────────── STANDBY ◄──── sendFailed (capture impossible;
                  ▼               ▲            blur kept, still playable)
              SAMPLING ──pause/ended
               │  (rVFC loop; seeked → immediate one-shot sample,
               │   also fires from STANDBY while paused)
               │ MAX_CONSECUTIVE_ERRORS
               ▼
             ERROR (fail-closed: blur kept, loop stopped)

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
- **Asymmetric hysteresis.** An unsafe sample masks instantly; the mask clears only after
  `CLEAN_STREAK_TO_CLEAR` (2) consecutive clean samples.

## Components

| Component          | File                                                                     | Role                                                                   |
| ------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Pure state machine | `entrypoints/content/video/session/machine.ts`                           | `(state, event) → (state, effects)`; no DOM, timers, or transport      |
| Registry + adapter | `entrypoints/content/video/session/registry.ts`                          | Owns live sessions, routes predictions by sessionId, executes effects  |
| Discovery          | `entrypoints/content/handlers/handleVideos.ts`                           | Routes discovered videos: blacklist styling or registry adoption       |
| Frame capture      | `entrypoints/content/video/frameCapture.ts`                              | Canvas capture, poster extraction, CORS workaround                     |
| Transport          | `entrypoints/content/communication/sender.ts`                            | `requestVideoFrameInference` (Chrome: ImageBitmap, Firefox: WebP blob) |
| Overlays           | `entrypoints/content/presentation/videoMaskOverlay.ts`, `boundingBox.ts` | Segmentation mask / bbox blur rendering                                |
| Background routing | `entrypoints/background/services/inferenceOrchestrationService.ts`       | Emits `IFramePrediction[]` keyed by `mediaMetadata.kind`               |

### The pure machine

`machine.ts` is a reducer with an injected notion of time: events carry `at` timestamps and timers
are requested as effects (`startTimer`/`cancelTimer`), so every behavior is unit-testable without
fake DOM or real clocks. Its effect vocabulary:

`applyBlur` · `clearBlur` · `captureThumbnail` · `sendSample{frameIndex}` · `applyVerdict` ·
`clearVerdict` · `setStatus{safe|unsafe|skipped|error}` · `startTimer`/`cancelTimer` · `cleanup`

Tuning constants (all in `machine.ts`):

| Constant                 | Value  | Meaning                                                                                    |
| ------------------------ | ------ | ------------------------------------------------------------------------------------------ |
| `THUMBNAIL_TIMEOUT_MS`   | 10 000 | Fail-closed clock, started at the **first actual send**; one retry, then finalized blocked |
| `SAMPLE_FLOOR_MS`        | 250    | Minimum interval between Frame Sample sends (~4 fps ceiling)                               |
| `SAMPLE_TIMEOUT_MS`      | 3 000  | Frees the single in-flight slot when a verdict is lost                                     |
| `WATCHDOG_MS`            | 5 000  | Mid-playback verdict silence → whole-video re-blur                                         |
| `CLEAN_STREAK_TO_CLEAR`  | 2      | Consecutive clean samples required to lift a mask                                          |
| `MAX_CONSECUTIVE_ERRORS` | 10     | Capture/send failures before ERROR (fail-closed)                                           |

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
- **Sampling transport**: capture returning `null` (CORS-tainted canvas, zero dimensions, no frame
  data yet) or a send failure dispatches `sendFailed`; the machine counts consecutive failures
  toward ERROR. Each capture+send round is capped by `CAPTURE_SEND_TIMEOUT_MS` (10 s, `registry.ts`)
  so a never-settling CORS-clone or poster load cannot occupy the in-flight slot forever.

### Discovery

`handleVideos.ts` is intentionally thin:

- **Blacklist policy** → blacklist styling only, no inference, no session.
- **Everything else** → `videoSessions.adopt(video, hostSettings)`. The registry itself waits out
  videos with no resolved source yet (`<video><source …>`, MSE, late `src` assignment) via a
  `loadstart` listener that keeps waiting while `currentSrc` is still empty (`srcObject` fires
  `loadstart` with no URL source), so discovery holds no state of its own.

## Processed status attributes

Set by the machine's `setStatus` effect (contract kept from the previous pipeline):

- `data-haramblock-processed-safe` — no unsafe content in the latest applied verdict
- `data-haramblock-processed-unsafe` — unsafe content detected (or fail-closed blocked)
- `data-haramblock-processed-skipped` — processing impossible (maps the machine's `error` status)

Exactly one is present after finalization; all are removed on disposal. The initial blur uses the
shared `haramblock-initial-blur` class.

## Testing

- **Unit** (`entrypoints/content/video/session/__tests__/machine.test.ts`): every machine behavior —
  adoption, timeout-at-first-send, verdict finalization, retry-then-blocked, pacing, staleness,
  hysteresis, watchdog re-blur + self-heal, lost-sample slot recovery, paused-seek one-shots,
  pause/ended, consecutive-error fail-close, terminal disposal, play-preempts-thumbnail.
- **E2E** (`tests/e2e/features/video.feature`): real-browser masking of a playing video, including
  the `<source>`-child discovery path.

## Future enhancements

- **Prediction caching** — cache verdicts (not frames) keyed by `[videoSrc+timestampKey]` to skip
  redundant inference on replays/seeks. The VideoSession identity (element×source) was chosen to
  keep such a cache coherent.
- **Timeline synchronization** — reuse cached verdicts during playback.
