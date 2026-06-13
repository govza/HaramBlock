# Production Logging System

This document describes the wide event logging implementation for HaramBlock.

## Overview

The logging system uses **wide events** (canonical log lines) instead of scattered log statements.
One comprehensive event is emitted per image when processing completes, making it easy to trace any
image through the entire pipeline.

**Key features:**

- **Wide events** - One event per image with all context (not scattered logs)
- **Stable reqId** - Hash of image URL for consistent correlation
- **Memory-only storage** - Last 500 events in `browser.storage.session` (ephemeral)
- **Console toggle** - Enable verbose console output in production via popup
- **Copy to clipboard** - Export events as JSON for debugging
- **Merged events** - Content timing merged into background event for complete picture

## Architecture

```
Content Script:
  Image detected → create timing context
    → blur applied
    → sent to background (record sendTime)
    → predictions received (record receiveTime)
    → styling applied (record applyTime)
    → send content timing to background for merge

Background Service Worker:
  Request received → check cache
    → if cached: emit cached event (stored only)
    → else: queue → inference → emit success/error event (stored only)
    → when content timing arrives: merge into existing event → log merged event to console
```

## Two Separate Systems

### 1. Wide Event Logging (Ephemeral Debug Output)

Stored in `browser.storage.session` (last 500 events). Used for real-time debugging via console
toggle and "Copy Logs" button. Events are emitted via `emitEvent()` and lost when the browser
closes.

### 2. Prediction Cache (Persistent Performance Data)

Stored in IndexedDB with each `IImagePrediction`. Used by PerformancePanel to show historical timing
stats per hostname. Data persists across sessions. See `IImagePrediction.processingTime` in
`utils/types/prediction.ts`.

---

## Wide Event Schema

All events use a single unified schema. Context-specific fields are only populated for their
respective context.

```typescript
interface WideEvent {
  reqId: string; // Hash of src - stable per URL
  src: string; // Image URL
  hostname: string;
  context: 'content' | 'background';
  timestamp: number;

  // Timings (all in ms)
  totalMs: number; // Total processing time

  // Background timing fields
  queueMs?: number; // Time waiting in queue
  fetchMs?: number; // Time to fetch image
  decodeMs?: number; // Time to decode image (createImageBitmap)
  inferenceMs?: number; // AI model inference time
  e2eMs?: number; // End-to-end time (content request to inference complete)

  // Content timing fields
  sendMs?: number; // Time to prepare and send to background
  waitMs?: number; // Time waiting for background response
  styleMs?: number; // Time to apply styling/overlays

  // Result
  status: 'success' | 'error' | 'skipped' | 'cached';
  detectionsCount?: number;
  cacheHit?: boolean;
  overlayType?: string; // blur | bbox | segment | full
  backend?: string; // webgpu | wasm
  error?: { message: string; type: string };

  version: string;
}
```

**Field usage by context:**

| Field             | Background | Content |
| ----------------- | ---------- | ------- |
| `queueMs`         | ✓          |         |
| `fetchMs`         | ✓          |         |
| `decodeMs`        | ✓          |         |
| `inferenceMs`     | ✓          |         |
| `e2eMs`           | ✓          |         |
| `sendMs`          |            | ✓       |
| `waitMs`          |            | ✓       |
| `styleMs`         |            | ✓       |
| `cacheHit`        | ✓          |         |
| `backend`         | ✓          |         |
| `overlayType`     |            | ✓       |
| `detectionsCount` | ✓          | ✓       |

## Key Files

- `utils/logging/emitEvent.ts` - Core event emission
- `utils/logging/eventBuffer.ts` - Session storage buffer (500 events max)
- `utils/logging/contentTiming.ts` - Content-side timing context
- `utils/logging/types.ts` - Type definitions
- `entrypoints/background/services/inferenceOrchestrationService.ts` - Background event emission

## Console Output

Events logged with stable hash prefix for correlation:

```
[f7a2] success example.com +165ms (background) { queueMs: 10, inferenceMs: 120, e2eMs: 165, detectionsCount: 2 }
```

The `[f7a2]` prefix is a hash of the image URL. Content timing (sendMs, waitMs, styleMs,
overlayType) is merged into the background event in storage but not shown in the initial console
log. Use "Copy Logs" to see the fully merged events.

## Design Decisions

| Decision                             | Rationale                                         |
| ------------------------------------ | ------------------------------------------------- |
| Hash URL for reqId                   | Stable ID - same image always has same reqId      |
| `browser.storage.session` for events | Ephemeral, shared across contexts, no disk I/O    |
| `browser.storage.local` for toggle   | Persists user preference                          |
| 500 event limit                      | Enough for debugging, bounded memory              |
| Merge content timing into background | One complete event per image with all timing data |
| Remove scattered logs                | Wide events capture all needed info in one place  |
