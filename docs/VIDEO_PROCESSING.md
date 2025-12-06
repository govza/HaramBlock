# Video Processing Architecture

This document describes the video processing feature for HaramBlock, extending the image filtering
system to handle video content with frame-by-frame AI inference.

## Overview

Video processing follows the same architectural patterns as image processing but adds:

- **Thumbnail/poster detection** for immediate filtering before playback
- **Frame extraction during playback** with adaptive rate limiting
- **Timeline synchronization** for cached predictions (planned)
- **Temporal smoothing** to prevent flickering during playback (planned)

## Current Implementation Status

### Completed (Core Video Processing)

| Component                 | File                                                   | Status  |
| ------------------------- | ------------------------------------------------------ | ------- |
| Video transfer types      | `utils/types/media.ts`                                 | ✅ Done |
| Video constants           | `utils/constants/video.ts`                             | ✅ Done |
| Frame capture utility     | `entrypoints/content/video/frameCapture.ts`            | ✅ Done |
| Thumbnail processing      | `entrypoints/content/video/thumbnail.ts`               | ✅ Done |
| VideoFrameProcessor       | `entrypoints/content/video/VideoFrameProcessor.ts`     | ✅ Done |
| Playback handler          | `entrypoints/content/video/playback.ts`                | ✅ Done |
| Video handler             | `entrypoints/content/handlers/handleVideos.ts`         | ✅ Done |
| Video predictions         | `entrypoints/content/presentation/videoPredictions.ts` | ✅ Done |
| Video mask overlay        | `entrypoints/content/presentation/videoMaskOverlay.ts` | ✅ Done |
| Initial video styling     | `entrypoints/content/presentation/initialStyling.ts`   | ✅ Done |
| Sender integration        | `entrypoints/content/communication/sender.ts`          | ✅ Done |
| BackgroundRpc methods     | `utils/messaging/services/backgroundRpc.ts`            | ✅ Done |
| MediaPipeline integration | `entrypoints/content/core/MediaPipeline.ts`            | ✅ Done |

### Planned (Future Enhancements)

| Component            | File                                                   | Status     |
| -------------------- | ------------------------------------------------------ | ---------- |
| Video cache service  | `entrypoints/background/services/videoCacheService.ts` | ⏳ Planned |
| VideoDatabase schema | `utils/db/db.ts`                                       | ⏳ Planned |
| Temporal smoothing   | `entrypoints/content/video/temporalSmoothing.ts`       | ⏳ Planned |
| Timeline sync        | `entrypoints/content/video/timelineSync.ts`            | ⏳ Planned |

## Architecture

### Separate Callbacks Architecture

**Key Design Decision:** Video frames use the same inference pipeline as images, but are routed via
**separate callbacks** to avoid fragile DOM-based routing:

1. Reusing existing inference orchestration with discriminated union metadata
2. Background routes results based on `mediaMetadata.kind` - no DOM queries
3. Separate callbacks: `emitImagePredictions()` and `emitFramePredictions()`
4. MediaPipeline subscribes to both, no routing logic needed

```
Video Frame Flow:
┌─────────────────────────────────────────────────────────────────────────┐
│ Content Script                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  handleVideos()                                                         │
│       │                                                                 │
│       ├─ applyInitialVideoStyling() ─────────────────────► blur class  │
│       │                                                                 │
│       ├─ queueThumbnailForInference() ──┐                               │
│       │                                 │                               │
│       └─ ensurePlaybackHandler() ───────┼──► requestVideoFrameInference │
│              │                          │              │                │
│              └─ on 'play' event         │              │                │
│                    │                    │              │                │
│           VideoFrameProcessor ──────────┘              │                │
│                                                        ▼                │
└────────────────────────────────────────────────────────┬────────────────┘
                                                         │
                                  postInferenceVideoFrame │
                                                         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Background Service Worker                                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  BackgroundRpc.postInferenceVideoFrame()                                │
│       │                                                                 │
│       └─ InferenceOrchestrationService.scheduleInferenceTask()          │
│              │         (with mediaMetadata: IFrameMetadata)             │
│              │                                                          │
│              └─ handleSuccess(): if kind === 'frame'                    │
│                       └─► emitFramePredictions(IFramePrediction[])      │
│                                         │                               │
└─────────────────────────────────────────┼───────────────────────────────┘
                                          │
                       onFramePredictions callback
                                          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Content Script (MediaPipeline)                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Two separate subscriptions (no DOM routing):                           │
│                                                                         │
│  onImagePredictions() ──► handleImagePredictions()                      │
│       └─► applyImagePredictionsToDom(IImagePrediction[])                │
│                                                                         │
│  onFramePredictions() ──► handleFramePredictions()                      │
│       └─► applyFramePredictionsToDom(IFramePrediction[])                │
│                 ├─ thumbnails (frameIndex === -1)                       │
│                 │     └─► find video[data-hb-handled="1"]               │
│                 └─ frames (frameIndex >= 0)                             │
│                       └─► find video[data-hb-video-status="processing"] │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Discriminated Union Metadata

The inference pipeline uses a discriminated union type to distinguish images from video frames:

```typescript
// utils/types/media.ts
type IMediaMetadata = IImageMetadata | IFrameMetadata;

interface IImageMetadata {
  kind: 'image';
  contentType: string | null;
  // ... HTTP cache headers
}

interface IFrameMetadata {
  kind: 'frame';
  videoUrl: string; // Original video source URL (for DOM matching)
  frameIndex: number; // -1 for thumbnail, 0+ for playback frames
  sessionId: string; // Unique playback session identifier
  timestampSec: number; // Position in video (seconds)
}
```

This allows `InferenceOrchestrationService.handleSuccess()` to route results without DOM queries:

- `kind === 'image'` → `emitImagePredictions(IImagePrediction[])`
- `kind === 'frame'` → `emitFramePredictions(IFramePrediction[])`

### Transfer Types

Defined in `utils/types/media.ts`:

- `IVideoFrameWithBitmap` - Chrome: ImageBitmap via MessageChannel (zero-copy)
- `IVideoFrameWithBlob` - Firefox: Compressed WebP Blob via browser.runtime
- `IVideoFrameTransfer` - Union type for cross-browser compatibility

## Content Script Components

### handleVideos.ts

Following the pattern of `handleImages.ts`, the video handler performs three steps:

```
handleVideos(videos, hostSettings)
    │
    ├─ 1. Apply initial protective styling (blur)
    │
    ├─ 2. Process thumbnail immediately (first pass)
    │     ├─ If poster attribute exists → load and inference poster image
    │     └─ Else → wait for metadata, capture first frame
    │
    └─ 3. Setup playback handler (deferred until play event)
```

### thumbnail.ts

Handles first-pass detection before video playback:

1. **Check for poster attribute** - If video has `poster` attribute, load it as an image
2. **Fallback to first frame** - Wait for `loadedmetadata` event, then capture frame at time 0
3. **Send for inference** with `frameIndex: -1` to indicate thumbnail
4. **Apply result** - If detection found, apply blur/mask overlay immediately

Key considerations:

- Use `crossOrigin = 'anonymous'` when loading poster images
- Handle `SecurityError` for cross-origin videos without CORS
- Convert to ImageBitmap for transfer (Chrome) or Blob (Firefox)
- Track thumbnail status in `data-hb-thumbnail-*` attributes

### frameCapture.ts

The frame capture utility extracts frames from video elements:

1. Create `OffscreenCanvas` sized to video dimensions
2. Use `ctx.drawImage(video, 0, 0)` to capture current frame
3. Convert to `ImageBitmap` via `createImageBitmap(canvas)`
4. Handle `SecurityError` for cross-origin content

Optimizations:

- Reuse canvas across captures (resize only when video dimensions change)
- Use `willReadFrequently: true` context option for better performance
- Single shared canvas per video element

### VideoFrameProcessor.ts

Core frame extraction during playback:

**Lifecycle:**

- Start on `play` event (via playback.ts)
- Pause on `pause`/`ended` events
- Capture immediately on `seeked` event (timeline changed)

**Frame Loop:**

- Use `requestAnimationFrame` for smooth timing
- Enforce minimum interval between captures (default: 200ms = 5 FPS)
- Track frame index and session ID

### Adaptive Rate Limiting

Adapt capture rate based on inference speed:

| Condition                            | Action                             |
| ------------------------------------ | ---------------------------------- |
| Inference faster than frame interval | Maintain target FPS                |
| Inference slower than frame interval | Slow down to match inference speed |
| Backlog > threshold (e.g., 3 frames) | Pause sending until backlog clears |

Implementation:

- Track `inferenceBacklog` counter (increment on send, decrement on result)
- Listen for `hb:inference-timing` custom event from prediction results
- Calculate effective interval: `max(minInterval, inferenceTime * 1.2)`
- Further slow down when backlogged: `interval *= (1 + backlog * 0.5)`

## Presentation Layer

### videoPredictions.ts

Applies frame predictions to video elements. Receives `IFramePrediction[]` directly via the
`onFramePredictions` callback - no DOM-based routing needed.

```typescript
export async function applyFramePredictionsToDom(
  framePreds: IFramePrediction[],
  hostSettings: IHostSettings
): Promise<void>;
```

**Flow:**

1. Separate thumbnail vs regular frame predictions by `frameIndex`
2. For thumbnails (`frameIndex === -1`): find videos with `[data-hb-handled="1"]`
3. For frames (`frameIndex >= 0`): find videos with `[data-hb-video-status="processing"]`
4. Apply overlays based on `hostSettings.outline` (segment or bbox)
5. Emit `hb:inference-timing` event for adaptive throttling
6. Mark video as processed and remove initial blur styling

### videoMaskOverlay.ts

Canvas-based overlay for segmentation masks on videos:

- Creates positioned `<div>` overlay with `<canvas>` child
- Renders pixelated blur effect over detected regions
- Handles poster images for thumbnail predictions (detected via
  `cacheMetadata.contentType === 'video/thumbnail'`)
- Uses `ensureCorsSafeSource()` for cross-origin video frame drawing
- Supports dynamic resizing with ResizeObserver
- Cleanup on video removal via MutationObserver

### initialStyling.ts

Video-specific styling functions:

- `applyInitialVideoStyling()` - Add blur class before processing
- `removeInitialVideoStyling()` - Remove blur after predictions applied

## Configuration

Defined in `utils/constants/video.ts`:

```typescript
export type VideoFrameLoopConfig = {
  frameInterval: number; // Minimum interval between frame captures (ms)
  maxErrors: number; // Max consecutive errors before stopping
  maxSendFps?: number; // Max frames per second to send for inference
};

export const DEFAULT_VIDEO_CONFIG: VideoFrameLoopConfig = {
  frameInterval: 100,
  maxErrors: 10,
  maxSendFps: 10
};
```

## Future Enhancements

### Temporal Smoothing (Planned)

Prevents flickering when predictions rapidly change between frames:

**State tracking per detection class:**

- `consecutivePositive` - frames with this class detected
- `consecutiveNegative` - frames without this class
- `isFiltering` - current filter state

**Logic:**

- Detection present → increment positive, reset negative
- Detection absent → increment negative, reset positive
- Start filtering when positive >= threshold
- Stop filtering when negative >= threshold

### Video Caching Strategy (Planned)

Design principles:

1. **Cache predictions, not frames** - Raw frames are too large for storage
2. **Index by timestamp** - Enable quick lookup during playback
3. **Session awareness** - Handle multiple playback sessions and seeking
4. **Granularity** - Round timestamps to 0.5 second intervals for efficient indexing

Database schema for `VideoDatabase`:

| Field                     | Purpose                        |
| ------------------------- | ------------------------------ |
| `[videoSrc+timestampKey]` | Compound primary key           |
| `hostname`                | For filtering by site          |
| `sessionId`               | Track playback session         |
| `timestamp`               | Actual frame time (float)      |
| `timestampKey`            | Rounded timestamp for indexing |
| `predictions`             | Detection results              |
| `cachedAt`                | When cached (for expiration)   |

### Timeline Synchronization (Planned)

During playback, synchronize cached predictions with current time to skip redundant inference.

## File Structure

```
entrypoints/content/
├── handlers/
│   └── handleVideos.ts          # ✅ Video lifecycle (like handleImages.ts)
├── video/
│   ├── VideoFrameProcessor.ts   # ✅ Playback frame extraction + adaptive rate
│   ├── frameCapture.ts          # ✅ Canvas-based frame capture utility
│   ├── thumbnail.ts             # ✅ Poster/thumbnail first-pass processing
│   ├── playback.ts              # ✅ Video playback handler
│   ├── temporalSmoothing.ts     # ⏳ Flickering prevention logic (planned)
│   └── timelineSync.ts          # ⏳ Cache-to-playback sync (planned)
├── presentation/
│   ├── videoPredictions.ts      # ✅ Apply IFramePrediction[] to video elements
│   ├── videoMaskOverlay.ts      # ✅ Canvas overlay for video blur/masks
│   └── initialStyling.ts        # ✅ +video styling functions
├── communication/
│   ├── listener.ts              # ✅ +onFramePredictions() subscription
│   └── sender.ts                # ✅ +requestVideoFrameInference()
└── core/
    └── MediaPipeline.ts         # ✅ Subscribes to both image & frame predictions

entrypoints/background/
└── services/
    ├── inferenceOrchestrationService.ts  # ✅ Routes by mediaMetadata.kind
    └── videoCacheService.ts              # ⏳ IndexedDB video caching (planned)

utils/
├── types/
│   ├── media.ts                 # ✅ IMediaMetadata union (IImageMetadata | IFrameMetadata)
│   └── prediction.ts            # ✅ IFramePrediction type (actively used)
├── db/
│   └── db.ts                    # ⏳ +VideoDatabase (planned)
├── constants/
│   └── video.ts                 # ✅ Video processing configuration
└── messaging/services/
    └── backgroundRpc.ts         # ✅ +postInferenceVideoFrame(), +emitFramePredictions()
```
