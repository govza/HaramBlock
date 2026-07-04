# Video masking: DVR delayed presentation, allow on inference-impossible

PR #69's VideoSession machine (ADR 0001) made playback masking reliable but not synchronous: Frame
Samples go out at ≥250 ms intervals and verdicts return after an inference round-trip, so a DOM mask
overlay applied "now" describes a frame displayed 0.3–0.8 s ago. On a playing video the mask
permanently chases the content, and unsafe regions leak between samples. The GIF pipeline does not
have this problem because playback is deferred until verdicts exist, frame and mask are composited
atomically on a canvas, and inertia stretches each verdict over the sampling gap.

The decision: give masked video playback the same three properties via **DVR delayed presentation**.
The `<video>` element stays the decoder; a canvas becomes the display, presenting buffered frames a
Presentation Delay `D` (1.5 s, fixed in stage 1) behind the live edge, so every presented frame's
verdict window is resolved before presentation. Captured rVFC frames (presentation-sized, ~13 fps,
≤640 px) fill a `FrameRing` bounded by time horizon and bytes; verdicts land in a `VerdictTrack`
keyed by media time; per presented frame, an unsafe verdict within the Inertia Window (derived from
the observed sampling cadence) composites its masks into the same draw, a clean verdict draws plain,
and **no verdict fails closed as a whole-blurred frame** — presentation never pauses. The machine
stays the authority: unsafe-while-playing whole-blurs instantly and starts the DVR (`warming`);
`bufferReady` swaps blur for canvas (`presenting`); the clean streak, pause/ended, or disposal stops
it. Paused verdicts keep the precise DOM overlay — DVR is strictly a playback presentation mode.
Buffering only happens while masked, so safe videos cost no memory. Audio stays live in stage 1
(lip-sync off by `D` only while masked).

The second decision: **inference-impossible finalizes as allow, not blur-forever**. Fail-closed blur
is justified only while a verdict is genuinely pending. When analysis can never happen — a permanent
capture failure (CORS-tainted canvas, detected as `SecurityError` in `frameCapture.ts`) or an
unbroken transient-failure streak — the session finalizes as ERROR with the blur cleared and status
`skipped`. Being unable to analyze a video is not evidence that it is unsafe, and a permanent blur
on un-analyzable content (previously the terminal ERROR and permanent-thumbnail behavior) punishes
ordinary cross-origin embeds. DVR unavailability alone (e.g. buffering throws `SecurityError` while
the CORS-clone sampling path still works) falls back to the warm-up whole-blur instead, because
analysis still works and the clean-streak exit remains reachable.

## Considered options

- **Predictive overlays** (extrapolate mask motion to cover the lag) — rejected: guessing where
  unsafe content moved is exactly the failure mode the pipeline exists to prevent.
- **Pause playback until verdicts arrive** (the GIF model literally) — rejected: videos are long and
  streamed; freezing playback per sample is unusable, and sites fight scripted pauses.
- **Block on inference-impossible** — rejected: permanently blurring everything the pipeline cannot
  read (most cross-origin videos without CORS headers) breaks far more legitimate content than it
  protects.
- **Buffer every playing video pre-emptively** (mask with zero warm-up) — rejected: tens of MB per
  video for the common safe case; the instant whole-blur already covers the warm-up gap.

Consequences: masked playback costs one delayed canvas plus ~20–35 MB of ring buffer per session
(hard-capped, oldest evicted); native controls are visually hidden while masked; content jumps
forward by `D` when the mask clears. Stage 2 (adaptive `D` from per-session latency stats, global
memory caps) and stage 3 (WebAudio delay sync) build on this without changing the machine's
lifecycle.
