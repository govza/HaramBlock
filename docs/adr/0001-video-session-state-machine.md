# Video pipeline: pure VideoSession state machine over rVFC, routed by session, fail-closed

Issue #53 reported the video pipeline as unreliable: videos with `<source>` children or
`preload="none"` were never picked up, late predictions could clear a mask a newer unsafe frame had
just applied, seeks left stale masks, and a dead service worker left videos blurred forever (or
unprotected mid-playback). We judged these symptoms to be consequences of the design — implicit
state scattered across `dataset` flags, a rAF/token-bucket loop paced by a global timing event, and
URL-based DOM queries for result routing — and decided to rearchitect rather than patch.

The new design: each video×resolved-source binding is a **VideoSession** with an explicit 6-state
machine (ADOPTED → THUMBNAILING → STANDBY ⇄ SAMPLING, plus ERROR and DISPOSED), implemented as a
pure reducer `(state, event) → (state, effects)` with an injected clock, wrapped by a thin DOM
adapter. Capture is paced by `requestVideoFrameCallback` (rAF shim as fallback) with at most one
in-flight Frame Sample per session and a ~250ms floor; `seeked` triggers a one-shot sample even
while paused. The Thumbnail is Frame Sample #−1, so thumbnail/playback races collapse into the
ordering rule. Predictions route back through a sessionId registry — no DOM queries — and are
dropped as stale unless they belong to the live session and carry a higher frameIndex than the last
applied. Mask clearing is asymmetric: unsafe applies instantly, clean clears only after 2
consecutive clean samples.

Verdict silence is **fail-closed with self-heal**, matching the GIF precedent (`forceBlocked` on
timeout): a thumbnail timeout retries once then finalizes as blocked, and a mid-playback watchdog
re-applies full blur when predictions stop arriving — but every fail-closed state remains exit-able
by a newer sample, so recovery is automatic once inference returns. The fail-closed timeout starts
at the first actual send, so a blank `preload="none"` player never times into a stuck blur.
Discovery gaps are fixed at the entry point, not in the machine: empty-src videos get a `loadstart`
listener for adoption (covers `<source>` children, MSE, late src), and posters are inferred
immediately without waiting for video data.

## Considered options

- **Patching the existing loop** (keep rAF/token bucket, add session checks and timeouts) —
  rejected: each symptom had a point fix, but the implicit-state design kept regenerating new races.
- **Session = playback run or seek-delimited epoch** — rejected in favor of element×source binding:
  per-run/per-epoch identities orphan in-flight predictions and fragment any future prediction
  cache; monotonic frameIndex ordering makes seek races benign without discarding valid results.
- **URL-based routing with added validation** — rejected: same-URL videos sharing verdicts is a
  correctness hazard, and routing stays coupled to `dataset` attributes.
- **Symmetric temporal smoothing** (the previously documented plan) — rejected: requiring N positive
  samples before masking shows unsafe frames while "warming up", contradicting the protection-first
  stance.
- **Fail-open on timeout** ("skipped", unblur) — rejected: contradicts the GIF precedent and the
  extension's purpose; brokenness must err toward masking.

## Consequences

- Same-URL videos on one page each run their own session and duplicate inference cost (frames are
  not cached); accepted for routing correctness.
- The pure core is unit-testable (transitions, staleness, hysteresis, watchdog) per the project's
  pure-logic-only unit test policy; DOM adapter behavior is covered by a new video e2e feature.
- `VideoFrameProcessor.ts`, `playback.ts`, `videoPredictions.ts` routing, and `thumbnail.ts` logic
  are replaced in place with no compatibility flag; the `data-haramblock-processed-*` attribute
  contract is preserved.
