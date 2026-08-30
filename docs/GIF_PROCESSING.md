# GIF Processing Architecture

This document describes how HaramBlock inspects and masks **animated GIFs**, extending the image
filtering system with multi-frame inference and masked canvas playback.

## Overview

An animated GIF is a single `<img>` element whose content changes over time. A static, single-frame
verdict is not enough — unsafe content can appear on any frame. So GIFs are decoded frame-by-frame,
a sampled subset is sent for AI inference, and unsafe GIFs are replayed through a canvas that masks
each displayed frame.

Key properties:

- **Sampled inference** — every frame is decoded for playback, but only a bounded, evenly-spread
  subset is sent to the model (see [Frame cap](#frame-cap-vs-mask-inertia)).
- **Per-frame masking with inertia** — each displayed frame is masked using nearby frame verdicts,
  with the persistence window sized to the sampling gap so un-inspected frames stay covered.
- **Fail-safe** — a verdict timeout, send failures, and force-block toggles all resolve toward
  hiding content, never revealing it.

## Relationship to image processing

GIFs are `<img>` elements, so they share the image lifecycle rather than getting a separate
processor (contrast videos, which are `<video>` and live in `core/VideoProcessor.ts`).

- `MediaPipeline` routes `<img>` → `ImageProcessor`, `<video>` → `VideoProcessor`.
- Inside `ImageProcessor.process()`, an early branch routes GIF candidates to `processGif()` and
  everything else to the static-image path:

  ```
  ImageProcessor.process(img)
    ├─ isGifCandidate(src)?  → processGif()       (GIF path)
    └─ else                   → queueInference()   (static-image path)
  ```

- GIF orchestration (the `gifSessions` map, aggregation, finalization) lives **in** `ImageProcessor`
  and reuses its infrastructure: the prediction cache, `findImagesBySrc`, `isBelowMinSizeForSrc`,
  the visibility/priority map, `badgeCounter`, overlay clearing, and the single-frame fallback.

So GIF handling is **separated where it differs** (detection, decode, playback, tuning) and **shared
where it is the same** (the `<img>` lifecycle).

| Concern                 | Module                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| Detection               | `entrypoints/content/gif/gifSupport.ts`                                                             |
| Decode + sampling       | `entrypoints/content/gif/gifDecoder.ts`                                                             |
| Orchestration           | `entrypoints/content/core/ImageProcessor.ts`                                                        |
| Masked playback         | `entrypoints/content/presentation/gifMaskPlayer.ts`                                                 |
| Tuning constants        | `utils/constants/gif.ts`                                                                            |
| Cross-context transport | `utils/messaging/services/backgroundRpc.ts`, `communication/sender.ts`, `communication/listener.ts` |

## Flow

```
ImageProcessor.processGif(img, src)
   │  create GifSession (keyed by src), apply initial blur
   ▼
decodeAndSendGif()
   │  fetch(src) → decodeGifFrames(blob)        decode ALL frames (≤ MAX_GIF_DECODE_FRAMES)
   │  sampleFrameIndices(n, gifInferenceFrameCap(n))   pick the subset to inspect
   │  session.frameCount = sampled count
   │  requestGifFrameInference(frame) for each sampled frame   (bitmap on Chrome / blob on Firefox)
   ▼
background: scheduleInferenceTask({ mediaMetadata.kind: 'gifFrame', sessionId, frameIndex })
   │  emitGifFramePredictions(...)
   ▼
MediaPipeline.onGifFramePredictions → ImageProcessor.handleGifFrameResults()
   │  aggregate per session; errored results count as failed frames
   │  finalize when received + failed ≥ frameCount  (or 20s timeout)
   ▼
finalizeGif() → applyGifVerdict(img)
   ├─ blocked  → gifMaskPlayer.createOrUpdatePlayer()   (masked canvas, native <img> hidden)
   └─ safe     → reveal, release decoded frame bitmaps
```

Transport mirrors video frames exactly (no URL fallback — frames are generated in the content
script). See [MESSAGING_CHANNEL.md](MESSAGING_CHANNEL.md) for the channel details.

## Frame cap vs. mask inertia

These are two different numbers solving two different problems. They are linked but not the same.

### Frame cap — how many frames we inspect

Bounds **cost**: a long GIF must not flood the inference queue. We decode every frame for playback
but send only an evenly-spread subset to the model. Defined in `gifDecoder.ts`:

```ts
// gifDecoder.ts — GIF_MIN_INFERENCE_FRAMES = 6, GIF_MAX_INFERENCE_FRAMES = 24
function gifInferenceFrameCap(frameCount: number): number {
  return Math.min(
    GIF_MAX_INFERENCE_FRAMES,
    Math.max(GIF_MIN_INFERENCE_FRAMES, Math.ceil(frameCount / 3))
  );
}
```

`sampleFrameIndices(frameCount, cap)` then picks that many indices, evenly spread and always
including the first and last frame. The **stride** between sampled frames is `frameCount / cap`.

### Mask inertia — how far one verdict reaches in playback

Restores **coverage**: because we skip frames, a displayed frame between two sampled frames has no
verdict of its own. Inertia is how many frames a detection's mask persists on each side, so the gaps
stay covered. Set in `ImageProcessor.decodeAndSendGif()`:

```ts
// GIF_MIN_MASK_INERTIA = 4 (the floor); the derived term is the sampling stride
session.maskInertia = Math.max(GIF_MIN_MASK_INERTIA, Math.ceil(totalFrames / sampledCount));
```

The derived term (`stride`) handles coverage; the floor (`GIF_MIN_MASK_INERTIA = 4`) handles
detection jitter — keeping a mask sticky across a single frame where the model's confidence dipped
below threshold. On long GIFs the stride dominates; on short/densely-sampled GIFs the floor wins.

`gifMaskPlayer` is a pure consumer of this value — it has no inertia constant of its own; the
`maskInertia` parameter is required and the single floor lives in `constants/gif.ts`.

**Worked example (240-frame GIF):** cap = `clamp(80, 6, 24)` = 24 → inspect every ~10th frame;
stride ≈ 10; inertia = `max(4, 10)` = ±10, so a hit on frame 30 masks frames 20–40, covering the
nine frames never inspected.

> **Rule of thumb:** the cap _shrinks_ the work; inertia _stretches_ each result to re-cover what
> the cap skipped. Bigger cap → smaller gaps → less inertia; smaller cap → bigger gaps → more.

## Aggregation and verdict

`createGifAggregatePrediction()` combines the per-frame verdicts into one `IImagePrediction`:

- **Block decision** — `shouldBlock` trips if _any_ sampled frame had a detection.
- **Detection count** — reports the **busiest single frame**, not the sum across frames, so the
  badge/timing count reflects one frame's worth rather than N copies of the same recurring subject.

## Fail-safe behaviors

- **Verdict timeout** — if verdicts never arrive within `GIF_VERDICT_TIMEOUT_MS` (20s), the GIF is
  finalized as blocked (whole-frame mask), not revealed.
- **Send/decode failures** — counted as `failedFrames`; finalization still completes, and any
  failure forces the blocked verdict.
- **Shared `src`** — other `<img>`s with the same GIF are blurred while inspection is in flight and
  picked up by `findImagesBySrc` when the verdict lands.

## Memory

- Decoded frame bitmaps are retained only while needed:
  - **Blocked** GIFs keep them — the canvas player animates them.
  - **Safe** GIFs release them immediately after finalize (they play natively).
- Force-blocking a _safe_ GIF later via quick-toggle uses a **whole-frame blur**
  (`applyBlacklistStyling`) rather than re-decoding — a safe verdict carries no per-frame detections
  to mask precisely, so no frames are needed.
- `MAX_GIF_DECODE_FRAMES` (300) caps decode work on pathological GIFs.
- `MAX_GIF_SESSIONS` (500) bounds tracked sessions; the oldest are evicted (frames closed, timers
  cleared) when exceeded.

## Known limitations

- **Detection is by `.gif` URL extension only** (`GIF_URL_PATTERN`). The `dataset.contentType` hint
  is plumbed but not currently populated, so extensionless / CDN-hosted GIFs are treated as static
  images. Cross-origin GIFs whose `fetch()` is blocked by CORS also fall back to the single-frame
  path.
- The native `<img>` keeps animating at `opacity: 0` behind the canvas player (minor CPU).
- Firefox MV2 lacks MessageChannel transport (shared with all media — see
  [MESSAGING_CHANNEL.md](MESSAGING_CHANNEL.md)); GIF frames fall back to the single-frame path
  there.
