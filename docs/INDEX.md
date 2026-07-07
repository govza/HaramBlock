# Documentation Index

This folder contains developer-focused documentation for HaramBlock (architecture notes, internal
APIs, and implementation details). If you’re a user, start with the project
[`README.md`](../README.md).

## Start Here

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
- **Running tests**: [TESTING.md](TESTING.md)
- **Interactive browser debugging (Playwright MCP + built extension)**:
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
