# Media Processing

The content script (`entrypoints/content/`) observes the DOM, queues inference, and masks images and
videos. Read the code for signatures; this doc covers the why.

## Vocabulary

**Verdict**: The final safe/unsafe decision for a piece of media, produced by aggregating one or
more predictions. _Avoid_: result, outcome, classification

**Prediction**: The model's detections for a single inferred input (one image, one GIF frame, one
video frame). _Avoid_: inference result, detection set

**Fail-closed**: The protection stance while a verdict is genuinely pending: the media stays masked
rather than being revealed. When analysis is permanently impossible, the media is allowed instead
(inference-impossible is not evidence of unsafe content). _Avoid_: fail-safe (ambiguous about
direction)

Video-processing vocabulary (VideoSession, Thumbnail, Bitstream Tap, Lookahead Analysis, Live
Masking, Sample Lattice, Verdict Timeline) lives in [VIDEO_PROCESSING.md](VIDEO_PROCESSING.md).

## Design Principles

1. **Derive state from DOM** - read state from CSS classes and overlays, don't track it separately
2. **Idempotent operations** - applying blur twice is a no-op, safe to retry
3. **Fire and forget** - queue async work, never block the observer
4. **Last write wins** - no version tracking; predictions are matched by src, so a stale one finds
   no element
5. **Self-cleaning overlays** - overlays end themselves when their image's source changes

## Layout

- `index.ts` - entry; sets up startup hiding, `useHostData`, `MediaPipeline`. Deliberately does
  **no** unload cleanup: tearing masks down in `beforeunload` uncovers the old page until the next
  document paints (and leaves a dead pipeline if navigation is canceled)
- `core/` - `DomObserver`, `MediaPipeline`, `ImageProcessor`, `VideoProcessor`, `InferenceTracker`
- `communication/` - `listener.ts` (inbound broadcasts), `sender.ts` (requests to background)
- `hooks/useHostData.ts` - settings + cached predictions
- `presentation/` - styling, CSS injection, overlays
- `video/`, `handlers/` - video; see [VIDEO_PROCESSING.md](VIDEO_PROCESSING.md)
- `gif/` - animated GIFs; see [GIF_PROCESSING.md](GIF_PROCESSING.md)

### `DomObserver`

- Scans existing DOM on start, then observes added/removed nodes and source attributes (`src`,
  `srcset`, `data-src`, `data-srcset`, `data-lazy-src`)
- **Pierces open shadow DOM**: each open shadow root gets its own MutationObserver. Custom elements
  seen without a shadow root are re-checked on a slow interval, since `attachShadow` often runs long
  after insertion (Reddit's `<shreddit-player>` behind `<shreddit-async-loader>`). Closed roots stay
  invisible (accepted)

### `MediaPipeline`

Routes `<img>` → `ImageProcessor`, `<video>` → `VideoProcessor`, subscribes to prediction
broadcasts. Video sessions suspend outside a 400 px viewport margin (1 s grace against boundary
flapping), because feed players stay connected and autoplay after being scrolled away.

### Processed status attributes

`finalizeImageProcessing()` sets exactly one of `data-haramblock-processed-safe` / `-unsafe` /
`-skipped` (unsupported, too small, or error); `resetImageStyling()` and src changes clear them.

## Overlays

### `imageMaskOverlay.ts`

A `<div>` + `<canvas>` that only paints; placement belongs to the overlay anchor.

- Clears the canvas when the image collapses to zero size (lightbox hide), so a stale frame never
  shows at its old size
- **Site-obscured copies**: when the site blurs an image at least as strongly as our initial blur
  (Reddit's decorative background copy), the mask is hidden — an opaque pixelated slab would be
  _more_ visible than the original

### `overlayAnchor.ts`

`anchorOverlay()` owns placement for every DOM-injected overlay (image mask, GIF player, video Mask
Presenter, quick-toggle button); adapters only paint in `onLayout`.

- **Homing**: covers go in as the element's next sibling mirroring its z-index, so player chrome
  above the element stays above the mask (Facebook Reels' Unmute button). For an element that is a
  direct child of a shadow root (Reddit's `<shreddit-player>` `<video>`), the overlay lives in the
  shadow root and the host is the containing block
- **Position context**: forces `position: relative` only while the box computes to `static`, and
  re-evaluates every refresh so later site styles win (Reddit's `<zoomable-img>` goes `fixed` when
  zoomed)
- **Offsets** are in the box's content coordinates (scroll added back — Reddit's zoom view scrolls)
- **Tracking**: `ResizeObserver` on the element **and its box** — a parent resize moves offsets even
  when the element's size is unchanged (flex re-centering, custom-element upgrade)
- **Source drift** (`trackSrc`): a changed `currentSrc` ends the overlay and routes the image back
  into the pipeline (`srcDrift.ts`)

### Surviving framework re-renders

Reddit's Lit lightbox renders several `<img>` copies, detaches/re-inserts nodes constantly, and
moves the post image between containers.

1. **Connectivity, not removal, decides.** A re-render usually re-inserts the node in the same
   mutation batch, so treating `removedNodes` as removal tore masks off visible images. The anchor
   re-homes and lets `isConnected` decide.
2. **Wait for re-attachment** (bounded, 30 frames) before giving up. `hasMaskOverlay()` reports an
   off-page overlay as inactive so the next pass can recreate it.
3. **One teardown path.** A "detach overlay, keep state" half-state would fight re-homing and
   re-attach a mask the user just revealed.

## Startup: no flash of unfiltered content

At `document_start` a global `opacity: 0` hides all media; it is removed only after `MediaPipeline`
has started and applied blur/overlays (immediately on whitelist or error). This is separate from the
per-image blur, which is the ongoing protection during inference.

## State model

| DOM condition             | State       |
| ------------------------- | ----------- |
| No blur class, no overlay | Unprocessed |
| Blur class, no overlay    | Pending     |
| Overlay (± blur class)    | Complete    |

The MutationObserver path only does class manipulation (~1 ms): overlay for current src → done;
cached → apply; else blur and queue inference.

## Priority

Visible images (via `IntersectionObserver`, 200 px margin) are sent before offscreen ones.

| Media            | Priority |
| ---------------- | -------- |
| Visible images   | 30       |
| Video thumbnails | 20       |
| Video frames     | 10       |
| Offscreen images | 0        |

Higher runs first; a running inference is not preempted. The dynamic-batch collector uses the same
ordering so autoplay frames cannot build a backlog ahead of new visible images. GIF frames use their
image's priority. Images are sent one by one (priority, memory, error isolation); array APIs exist
only for seeding cached predictions.

## Source changes

- **Debounced** (150 ms): sites like Google Images swap `src` repeatedly (placeholder → thumbnail →
  full); processing every swap left images stuck blurred because earlier load listeners aborted.
  Overlays clear and blur applies immediately; processing waits for the source to stabilize
- Unchanged re-stamps (Reddit re-sets identical `src`/`srcset`) are ignored by comparing the
  resolved source with the last one processed
- **`resolveImageSource()`**: Firefox keeps `currentSrc` on the previous request until the new size
  is known, so the Google Images placeholder→thumbnail swap looked like a no-op and the thumbnail
  rendered bare. Without `srcset`/`<picture>`, the reflected `src` is authoritative. A per-image
  `load` listener re-runs `handleSrcChange` when the resolved source drifts
- **`isPlaceholderResolution`**: decoded images under 32 px (or the host minimum, if smaller) are
  finalized `skipped` — nothing to detect, and they clogged single-lane mobile queues

### Load detection

Waits on both `decode()` and `load`, whichever first. A `decode()` rejection is fatal only when the
image is `complete` with no dimensions: Firefox rejects spuriously for unstarted `loading="lazy"`
images and mid-decode `src` swaps, and treating that as fatal revealed images unmasked.

### Finding images by src

Attribute selectors match the literal attribute, not the resolved URL, so `findImagesBySrc` queries
blurred/blacklisted images and compares their resolved source.

## Mask geometry

Spaces: original (intrinsic) → letterboxed model input / mask grid → element box → content rect
(after `object-fit`, `computeRenderedContentRect` in `imageLayout.ts`).

- **srcset pitfall**: `naturalWidth/Height` are density-corrected CSS dimensions, not resource
  pixels. Fine for aspect math, never for a `drawImage` source rect (an overshooting rect painted
  masks only over the top-left of Reddit gallery images). The background derives prediction size
  from the decoded `ImageBitmap` for the same reason
- `maskCoverage.ts` owns the grid: union of cells above threshold, cropped to the real-pixel window,
  as rects (video `clip-path`) or a pixelated paint (image/GIF)
- `croppedMaskTransform()` covers the cropped masks the inference library emits

## Deduplication

`InferenceTracker` dedupes in-flight requests by src and records the **owning** element (its load
listeners fire the request). Frameworks can replace the element before a lazy image loads; with a
plain set the entry stayed pending forever and every later copy stayed blurred. A new copy
**adopts** the request when the owner is disconnected, or stalled while the new copy has pixels.
Duplicate sends are harmless (predictions keyed by src).

Watchdogs: 120 s from send (task lost before running), and 20 s from the background's
`status: 'started'` — queue wait is unbounded on slow devices, and a queue-based timeout revealed
below-fold Google Images on Firefox mobile. Each retries once; the second timeout **fails closed**
(blur stays, entry cleared so a late prediction still applies). Only `status: 'error'` finalizes as
`skipped`, after two attempts.

The background joins requests for an already queued/running `hostname + src`, raising priority for a
higher-priority joiner and re-sending `started` to a joiner of a running task so its watchdog arms.

## Policies

- **Whitelist**: skip processing
- **Blacklist**: immediate heavy blur/opacity
- **Process**: protective blur during analysis, then overlays
