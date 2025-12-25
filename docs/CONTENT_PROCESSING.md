# Content Processing Architecture

This document describes the **design principles** and **architectural decisions** for the content
script's image processing system.

For module-level documentation and implementation details, see
[CONTENT_SCRIPT.md](./CONTENT_SCRIPT.md).

## Design Principles

1. **Derive state from DOM** - Don't track state separately; read it from CSS classes and overlays
2. **Idempotent operations** - Applying blur twice = no-op, safe to retry
3. **Fire and forget** - Queue async work, never block the observer
4. **Last write wins** - No version tracking; latest prediction for a src just overwrites
5. **Self-cleaning overlays** - Overlays detect when their image changes and clean themselves

## Initialization: Preventing Flash of Unfiltered Content

Browser-cached images can render before the content script has a chance to process them. To prevent
this "flash of unfiltered content":

```
document_start (earliest possible)
       │
       ▼
Inject global hiding: img { opacity: 0 !important; }
       │
       ▼
Fetch host settings + cached predictions (async)
       │
       ▼
DOMContentLoaded
       │
       ▼
Start MediaPipeline (processes existing images, applies blur/overlays)
       │
       ▼
Remove global hiding style
       │
       └── Images now visible with appropriate blur/overlay applied
```

**Key points:**

- `runAt: 'document_start'` ensures we inject hiding style before any images render
- Global `opacity: 0` hides ALL images until we're ready
- Removal happens AFTER pipeline starts, so images are already protected
- If whitelist policy or error, hiding is removed immediately (no processing needed)

This is **separate from per-image blur** - the global hide is a startup-only safeguard, while blur
class is the ongoing protection during inference.

## State Model

State is **derived from DOM**, not tracked separately:

| DOM Condition              | Derived State   | Meaning               |
| -------------------------- | --------------- | --------------------- |
| No blur class, no overlay  | **Unprocessed** | Needs processing      |
| Has blur class, no overlay | **Pending**     | Waiting for inference |
| Has overlay (± blur class) | **Complete**    | Prediction applied    |

```typescript
// State derived from DOM - no tracking needed
function getState(img: HTMLImageElement): 'unprocessed' | 'pending' | 'complete' {
  if (hasOverlay(img)) return 'complete';
  if (hasBlurClass(img)) return 'pending';
  return 'unprocessed';
}
```

## Processing Flow

### MutationObserver Callback (Must be fast!)

```
onMediaAdded/onAttributesChanged(img)
       │
       ├── Has overlay for CURRENT src? → Done (already complete)
       │
       ├── In cache? → Apply prediction immediately
       │
       └── Neither? → Apply blur, queue inference

Total blocking time: ~1ms (just class manipulation)
```

### Inference Queue (Async, non-blocking)

```
queueInference(img, src)
       │
       ▼
[Async] Wait for load if needed
       │
       ▼
[Async] Send to background
       │
       └── No callbacks, no state updates
           Background will broadcast prediction when ready
```

### Prediction Broadcast (Background → Content)

```
onPrediction({ src, predictions })
       │
       ▼
Find all img elements with this src
       │
       ▼
For each: apply overlay, remove blur class
       │
       └── If img.src changed, overlay auto-cleans via ResizeObserver
```

## Handling Source Changes

Instead of complex version tracking, use **idempotent re-detection**:

```
src changes (MutationObserver fires)
       │
       ▼
handleSrcChange(img)
       │
       ├── Clear existing overlays
       │
       └── Process as new image:
              ├── Check cache for new src
              ├── Apply blur if not cached
              └── Queue inference if needed
```

### Self-Cleaning Overlays

Overlays track the `src` they were created for and self-clean when it changes:

```typescript
// In ResizeObserver callback
const currentSrc = image.currentSrc || image.src;
if (state.trackedSrc && currentSrc !== state.trackedSrc) {
  this.clearMaskOverlay(image); // Self-cleanup
  return;
}
```

## Race Conditions - Why They Don't Matter

### Old Pattern (Complex)

```
t=0: Inference starts for src=A
t=1: src changes to B
t=2: Inference for A completes
t=3: Check version... reject... complex logic...
```

### New Pattern (Simple)

```
t=0: Inference starts for src=A
t=1: src changes to B, blur applied, new inference queued
t=2: Inference for A completes, tries to find img[src=A]
t=3: No match found (src is now B), prediction cached but not applied
t=4: Inference for B completes, applies to img[src=B] ✓
```

**Key insight**: Predictions are matched by `src`, not by element reference. If the src changed, the
old prediction simply won't find any matching elements.

## Deduplication

### Inference Requests

Use a simple Set to track in-flight requests:

```typescript
const pending = new Set<string>(); // src URLs

function queueInference(img, src) {
  if (pending.has(src)) return; // Already queued
  pending.add(src);
  // ... send request
}

function onPrediction(src) {
  pending.delete(src);
}
```

### DOM Processing

Blur class acts as marker - if image has blur class, don't re-apply:

```typescript
function process(img) {
  if (img.classList.contains('haramblock-initial-blur')) {
    return; // Already pending
  }
  img.classList.add('haramblock-initial-blur');
  queueInference(img, img.src);
}
```

## Performance Characteristics

| Operation         | Blocking Time | Notes                             |
| ----------------- | ------------- | --------------------------------- |
| Add blur class    | <1ms          | Sync, single classList.add        |
| Check for overlay | <1ms          | Sync, WeakMap lookup              |
| Queue inference   | <1ms          | Just adds to Set + posts message  |
| Apply overlay     | ~5-10ms       | Async, uses requestAnimationFrame |
| Remove blur       | <1ms          | Sync, classList.remove            |

**MutationObserver callback total: <3ms** (acceptable for 60fps)
