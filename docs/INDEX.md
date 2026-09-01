# Documentation Index

HaramBlock is a browser extension for gaze protection: on-device AI detects awrah in images, GIFs,
and video frames as the user browses, and masks it before it is seen.

This folder contains developer-focused documentation (architecture notes, internal APIs, and
implementation details). If you’re a user, start with the project [`README.md`](../README.md).

## Start Here

- **Domain vocabulary**: media terms (Verdict, Prediction, Fail-closed) in
  [MEDIA_PROCESSING.md](MEDIA_PROCESSING.md); video terms (VideoSession, DVR, …) in
  [VIDEO_PROCESSING.md](VIDEO_PROCESSING.md)
- **Build / verify a release**: [SOURCE_CODE_REVIEW.md](SOURCE_CODE_REVIEW.md)
- **Understand the overall architecture**:
  - [MEDIA_PROCESSING.md](MEDIA_PROCESSING.md) (content script - runs on webpages)
  - [MESSAGING_CHANNEL.md](MESSAGING_CHANNEL.md) (content ↔ background transport)
  - [REACTIVE_SETTINGS.md](REACTIVE_SETTINGS.md) (per-site settings storage + UI reactivity)
  - [POPUP.md](POPUP.md) (popup UI components and state management)
- **Video filtering details**: [VIDEO_PROCESSING.md](VIDEO_PROCESSING.md)
- **Animated GIF filtering details**: [GIF_PROCESSING.md](GIF_PROCESSING.md)
- **AI model (architecture, classes, registry, per-model perf)**: [MODEL.md](MODEL.md)
- **Inference pipeline (runtime, queueing, adaptive batching)**:
  [INFERENCE_PIPELINE.md](INFERENCE_PIPELINE.md)
- **Batched inference benchmark results**: [PHASE2_RESULTS.md](PHASE2_RESULTS.md)
- **Telemetry (structured logs, traces, metrics)**: [LOGGING.md](LOGGING.md)
- **Running tests**: [TESTING.md](TESTING.md)
- **Interactive browser debugging (launch, probe, iterate, clean up)**:
  [BROWSER_DEBUGGING.md](BROWSER_DEBUGGING.md); alternative Playwright MCP setup in
  [PLAYWRIGHT.md](PLAYWRIGHT.md)

## Project Map (High Level)

- **Content script**: `entrypoints/content/`
  - Observes the DOM, queues inference, and applies masking styles.
- **Background**: `entrypoints/background/` + `utils/messaging/services/`
  - Runs inference orchestration, caching, and message routing.
- **Popup UI**: `entrypoints/popup/` → [POPUP.md](POPUP.md)
  - Per-site settings controls (policy, strictness, masking).
- **Options UI**: `entrypoints/options/`
  - Bulk/advanced settings views.
- **Storage (IndexedDB)**: `utils/db/`
  - Dexie database + repositories for settings and cached predictions.
