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
- **AI model and inference**: [MODEL.md](MODEL.md)
- **Planned: parallel GPU inference**: [PLAN.md](PLAN.md)
- **Running tests**: [TESTING.md](TESTING.md)

## Project Map (High Level)

- **Content script**: `entrypoints/content/`
  - Observes the DOM, queues inference, and applies masking styles.
- **Background**: `entrypoints/background/` + `utils/messaging/services/`
  - Runs inference orchestration, caching, and message routing.
- **Popup UI**: `entrypoints/popup/` → [POPUP.md](POPUP.md)
  - Per-site settings controls (policy, strictness, outline).
- **Options UI**: `entrypoints/options/`
  - Bulk/advanced settings views.
- **Storage (IndexedDB)**: `utils/db/`
  - Dexie database + repositories for settings and cached predictions.
