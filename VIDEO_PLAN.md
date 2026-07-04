# VIDEO_PLAN — Synchronous (zero-lag) video masking via delayed presentation

Working plan for the next stage of the video pipeline. Written to be self-sufficient: a fresh
session should be able to continue from here without prior context.

> **Status**: Stage 0 and Stage 1 are implemented on this branch (see
> `docs/adr/0002-dvr-delayed-presentation.md` and the DVR section of `docs/VIDEO_PROCESSING.md`).
> Remaining: Stage 2 (adaptive `D`, global memory caps) and Stage 3 (audio sync). The CORS-tainted
> e2e scenario from §6 was not added — the e2e gallery fixture is single-origin, so a tainted
> cross-origin video cannot be staged reliably; the permanent-failure path is unit-tested instead.

## 1. Where we are

- Branch: `fix/53-video-pipeline-reliability` (PR **#69**, targets `master`). Fixes issue #53.
- PR #69 replaced the legacy frame loop with a per-(element × source) **VideoSession** state
  machine: pure reducer `entrypoints/content/video/session/machine.ts` + DOM adapter/registry
  `entrypoints/content/video/session/registry.ts`. See `docs/VIDEO_PROCESSING.md`, ADR 0001,
  `CONTEXT.md` (vocabulary: VideoSession, Thumbnail, Frame Sample, Stale Prediction, Verdict).
- A review pass already landed on this branch (commit `fix(video): close review gaps…`): fail-closed
  capture below `HAVE_CURRENT_DATA`, registry-owned pending adoption, serialized overlay chain,
  capture/send timeout, `emptied` handling, dead-code removal.
- PR #70 (bbox removal) is **merged to master**; this branch is rebased on top of it. Masking is
  segmentation-only now (`hostSettings.outline` and `boundingBox.ts` no longer exist).
- Unit suite: 136 tests green. `docs/GIF_PROCESSING.md` describes the GIF pipeline we are mirroring.

### Dev-environment quirks (needed to build/test)

- `node` is not on PATH in non-interactive shells:
  `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"` before `pnpm`/`git commit` (husky
  needs node too).
- A leftover worktree pollutes vitest/eslint full runs; use
  `pnpm test:unit run --exclude '**/.claude/**'` and lint changed files explicitly.
- **Do not add `Co-Authored-By: Claude` trailers to commits** (owner preference; history was
  rewritten to remove them).
- e2e (`pnpm e2e`) needs Chrome-for-Testing downloads that may be blocked on this network; a CfT
  binary override via `goog:chromeOptions.binary` + `wdio:chromedriverOptions.binary` works.

## 2. The problem

The segment mask overlay lags playback. Two layers:

1. **Structural**: samples go out at ≥250 ms intervals (`SAMPLE_FLOOR_MS`) and verdicts return after
   the inference round-trip (~100–500 ms). The machine applies the mask "now", but the geometry
   describes a frame displayed ~0.3–0.8 s ago. On a playing video the mask permanently chases the
   content; unsafe regions leak between samples.
2. **Render overhead**: `videoMaskOverlay.createMaskOverlay` awaits poster loads / CORS-clone
   sources before inserting the canvas.

The GIF pipeline does not have this problem because (a) playback is deferred until verdicts exist,
(b) frame + mask are composited atomically on a canvas, (c) inertia stretches each verdict over the
sampling gap. Goal: give video the same three properties.

## 3. Target design — DVR: delayed masked presentation

The `<video>` element becomes the **decoder**; a canvas becomes the **display**, presenting frames a
delay `D` behind the live edge. `D` is sized to the inference round-trip, so every presented frame's
verdict window is resolved _before_ presentation. Mask and frame are drawn in the same canvas draw —
they cannot desynchronize.

| GIF concept                            | Video equivalent                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| Decode all frames upfront              | Ring buffer of captured frames (rVFC), spanning `D` seconds                        |
| Infer a sampled subset (cap)           | Existing 4 fps sampling floor, sampled at the **live edge**                        |
| Play only after finalize               | Present the buffered frame with `mediaTime ≈ now − D`                              |
| Inertia = sampling stride (frames)     | Inertia = time window (sampling interval + jitter margin), keyed by `timestampSec` |
| Blocked → canvas player; safe → native | Masked session → DVR canvas; clean streak → native resumes                         |

### Presentation rule (per presented frame)

For the frame about to be drawn, look up verdicts whose `timestampSec` lies within the inertia
window around the frame's `mediaTime`:

- Unsafe verdict in window → composite its mask into the frame (reuse the GIF player's RLE-decode +
  downscale-mask compositing approach; see `gifMaskPlayer.ts`).
- Clean verdict in window → draw the frame clean.
- No verdict resolved yet (inference running late despite `D`) → draw the frame **whole-blurred**
  until verdicts catch up. This keeps presentation airtight without ever pausing.

### Lifecycle (machine stays the authority)

- Verdict-less / safe session → **native playback**, exactly as today (blur only until the first
  verdict, as today).
- First **unsafe playback verdict** → instant whole-video blur (unchanged "instant on"), and the DVR
  starts: capture into the ring buffer; once `D` of content is buffered, the canvas takes over —
  masked, synced, delayed playback replaces the full blur.
- `CLEAN_STREAK_TO_CLEAR` (2) consecutive clean samples → destroy the player, release buffers,
  reveal native (content jumps forward by `D`; same replace semantics as the GIF player).
- Source change / dispose → tear down the player and buffers (existing `cleanup` effect path).
- Paused video + unsafe verdict → the existing precise DOM overlay is fine (static frame, no drift).
  DVR is a _playback_ presentation mode.

### Decisions already made (owner)

1. **Fallback is ALLOW, not block.** If the pipeline cannot analyze or present — capture impossible
   (CORS-tainted, DRM/EME), DVR unavailable — the video **plays natively, un-blurred**, finalized
   with status `skipped`. Inference-impossible ≠ unsafe. Fail-closed blur applies only while a
   verdict is genuinely pending, for a bounded time.
   - This changes the current terminal ERROR behavior: today `MAX_CONSECUTIVE_ERRORS` → phase
     `error` + `applyBlur` + status `skipped`-attr. New behavior: phase `error` → `clearBlur` +
     `clearVerdict` + `setStatus 'skipped'` + stop sampling/ticker.
   - Same philosophy for the thumbnail path: a video whose thumbnail can never be captured
     (permanent failure, e.g. taint) should end up allowed/`skipped`, not blurred forever. The
     current `sendFailed`-in-thumbnailing → standby + `setStatus 'unsafe'` (blur kept) should be
     revisited: keep fail-closed only while attempts are still possible; finalize to allow when
     capture is _permanently_ impossible. Distinguish permanent (SecurityError/taint detected in
     `frameCapture.ts`) from transient (no data yet) — plumb a `permanent: boolean` onto
     `sendFailed`.
2. **Audio stays live in stage 1** (native element keeps playing sound; lip-sync off by `D` only
   while masked). WebAudio `DelayNode` sync is a later stage.
3. **Buffer only while masked.** Safe/verdict-less playing videos cost no memory. The gap between
   "unsafe verdict lands" and "DVR warmed up" is covered by the instant whole-blur.

### Sizing / budgets

- Capture for the buffer at presentation size, capped ~640 px wide, ~12–15 fps. `D = 1.5 s` → ~20–35
  MB per masked, playing video. Hard-cap buffer memory per session and globally (evict oldest
  session buffers; fall back to whole-blur → then allow per decision 1 only if analysis itself is
  impossible — DVR eviction alone falls back to whole-blur, because analysis still works).
- Adaptive `D` (stage 2): per-session `sampleSent → predictionReceived` p95 + margin, clamped [600
  ms, 2000 ms]. Both timestamps already flow through machine events.
- Inertia window: `sampleInterval + jitterMargin` — derive from actual send cadence rather than
  hardcoding; floor mirrors `GIF_MIN_MASK_INERTIA` rationale (detection jitter).

### Site-integration notes

- Canvas overlay: `pointer-events: none`; custom JS site controls keep working. Native-controls
  videos lose visible controls only while masked (acceptable; masked = content being protected).
- The presented canvas must track element geometry (resize observer / per-draw measure, as the
  existing overlays do) and fullscreen changes.
- `captureStream()` is NOT required for stage 1 (we draw buffered bitmaps); it only matters for the
  later audio-delay stage.

## 4. Implementation map

New modules:

- `entrypoints/content/video/dvr/frameRing.ts` — ring buffer of `{ bitmap, mediaTime, at }`, bounded
  by duration + memory; `push`, `frameAt(mediaTime)`, `release()`.
- `entrypoints/content/video/dvr/verdictTrack.ts` — ordered verdicts
  `{ timestampSec, unsafe, masks, maskTransform, width, height }` with
  `verdictFor(mediaTime, inertiaWindow)`; pruned to buffer horizon.
- `entrypoints/content/presentation/videoDvrPlayer.ts` — canvas presenter: warm-up, per-tick draw
  (frame + mask composite or whole-blur), geometry tracking, teardown. Pure consumer of ring + track
  (mirrors `gifMaskPlayer` role).

Machine (`machine.ts`) additions (keep reducer pure):

- State: `presenting: boolean` (DVR active); reuse `masked` as the driver.
- Events: `bufferReady` (DVR warmed up), `sendFailed` gains `permanent?: boolean`.
- Effects: `startDvr`, `stopDvr` (registry executes); ERROR transition effects change per decision 1
  (allow instead of blur).
- Transitions: unsafe-in-sampling → (as today masked=true, applyVerdict…) **plus** `startDvr`;
  `bufferReady` → `presenting=true` (registry swaps blur → canvas); clean-streak clear or
  pause/ended or dispose → `stopDvr`, `presenting=false`.
- NOTE: with DVR active, per-sample `applyVerdict` DOM-overlay renders should be suppressed (the DVR
  composites masks itself); keep DOM overlay for paused/standby verdicts.

Registry (`registry.ts`):

- Execute `startDvr`/`stopDvr`; feed rVFC captures into the ring while DVR active (reuse existing
  ticker; add a second, cheaper buffer-capture path at ~12–15 fps, downscaled).
- Route predictions into the session's `verdictTrack` in addition to the machine event (keyed by
  `timestampSec`, which `requestVideoFrameInference` already sends; verify the background echoes it
  back on `IFramePrediction` — it does: `timestamp`/`timestampSec` via `mediaMetadata`).
- Permanent-failure detection: `frameCapture.ts` returns null on SecurityError today; change to a
  discriminated result (`{ bitmap } | { failure: 'permanent' | 'transient' }`) so `sendFailed` can
  carry `permanent`.

Docs: update `docs/VIDEO_PROCESSING.md` (new presentation section, ERROR-allows semantics),
`CONTEXT.md` (new terms: DVR, Presentation Delay `D`, Inertia Window), ADR addendum or ADR 0002 for
the DVR + allow-fallback decisions.

## 5. Staging

**Stage 0 — allow-fallback semantics (small, independent, do first)**

- ERROR phase → allow (clearBlur/clearVerdict/`skipped`, stop ticker); `sendFailed.permanent`;
  permanent thumbnail failure → allow instead of blurred-forever-`unsafe`.
- Update `machine.test.ts` (behaviors listed in §6) + docs.
- Acceptance: CORS-tainted video plays un-blurred with `data-haramblock-processed-skipped` after
  bounded attempts; transient failures still fail closed while pending.

**Stage 1 — DVR core (the substance)**

- frameRing + verdictTrack + videoDvrPlayer; machine `startDvr/bufferReady/stopDvr`; fixed
  `D = 1500 ms`; audio live; buffer only while masked; whole-blur during warm-up and verdict-late
  frames; DOM overlay suppressed while presenting.
- Acceptance: on an unsafe playing video, after warm-up the canvas shows delayed playback with masks
  exactly on the unsafe regions, no chase/leak; clean streak → native resumes; dispose
  mid-presentation leaks nothing (bitmaps closed, canvas removed).

**Stage 2 — adaptive `D` + memory guards**

- Per-session latency stats → `D`; global/session buffer caps with whole-blur fallback on eviction.

**Stage 3 (optional) — audio sync**

- `captureStream()` + WebAudio `DelayNode` where media allows; skip silently otherwise.

Each stage: `pnpm compile`, scoped lint, `pnpm test:unit run --exclude '**/.claude/**'`, commit (no
Claude trailer), push to the PR branch.

## 6. Test plan

Machine unit behaviors (extend `machine.test.ts`):

- ERROR finalizes as allow: effects contain clearBlur + setStatus skipped, ticker-stop effect; no
  applyBlur.
- `sendFailed(permanent)` in thumbnailing → allow immediately (no retry loop).
- Unsafe-in-sampling emits `startDvr`; `bufferReady` sets presenting; clean-streak clear emits
  `stopDvr` and reveals; pause/ended while presenting emits `stopDvr` (paused → DOM overlay path);
  dispose while presenting → cleanup + stopDvr exactly once.
- No `applyVerdict` DOM effect while presenting.

New pure-logic units: frameRing (eviction, frameAt selection), verdictTrack (window lookup, pruning,
fail-closed "no verdict yet" answer).

e2e (`tests/e2e/features/video.feature`): existing three scenarios must keep passing (poster mask
before playback now presents via DOM overlay path — unchanged; safe video native). Add: unsafe
playing video → canvas player appears (`videoDvrPlayer` data attribute), native video visually
hidden; CORS-tainted fixture → verdicted `skipped`, no blur.

### Verified live (Playwright MCP, built extension, real inference)

- Unsafe playing video: verdicted unsafe → whole-blur → DVR canvas takes over (native at
  `opacity: 0`), frames drawn clean with the detected regions pixelated exactly along the
  segmentation contours. Verdicts keyed by `timestampSec` land in the track (~3/s); the presenter
  resolves them within the cadence-derived inertia window.
- **Observed**: Chrome fires `seeked` on every `loop` restart, so a looping video re-warms the DVR
  (whole-blur ≈ `D`, fresh ring + track) each iteration. Fail-closed and correct, but a blur flash
  per loop — candidate for a Stage 2 refinement (detect the wrap, reuse verdicts modulo duration).

## 7. Open questions (decide during implementation, none blocking Stage 0/1)

- Does the DVR replace the whole-blur _watchdog_ path too (verdict silence mid-playback)? Likely yes
  while presenting (verdict-late frames already whole-blur per-frame), keep watchdog for
  native-playback sessions.
- Seek during presentation: ring buffer discontinuity — simplest correct answer: flush buffer,
  whole-blur, re-warm (mirror of pendingSeek semantics).
- Poster-verdict unsafe + user presses play: DVR needs warm-up; instant whole-blur covers it —
  confirm UX acceptable vs. keeping DOM overlay until first playback verdict.
- Multiple simultaneously-masked videos: global memory cap policy (evict which?).
