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

GIFs are `<img>` elements, so they share the image lifecycle: `ImageProcessor.process()` routes GIF
candidates to `GifInspector`, which reuses the image infrastructure (cache, blur, verdict
presentation, single-frame fallback) through injected dependencies.

| Concern                 | Module                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| Detection               | `entrypoints/content/gif/gifSupport.ts`                                                             |
| Decode + sampling       | `entrypoints/content/gif/gifDecoder.ts`                                                             |
| Orchestration           | `entrypoints/content/gif/gifInspector.ts`                                                           |
| Verdict aggregation     | `entrypoints/content/gif/gifVerdict.ts`                                                             |
| Fetch / decode / send   | `entrypoints/content/gif/gifTransport.ts`                                                           |
| Masked playback         | `entrypoints/content/presentation/gifMaskPlayer.ts`                                                 |
| Tuning constants        | `utils/constants/gif.ts`                                                                            |
| Cross-context transport | `utils/messaging/services/backgroundRpc.ts`, `communication/sender.ts`, `communication/listener.ts` |

## Flow

Decode all frames, send a sampled subset for inference, aggregate per-frame results, then either
replay through the masked canvas player (blocked) or reveal and release frames (safe). Transport
mirrors video frames (see [MESSAGING_CHANNEL.md](MESSAGING_CHANNEL.md)).

## Frame cap vs. mask inertia

- **Frame cap** (`gifInferenceFrameCap`) bounds cost: roughly a third of the frames, clamped to
  6–24, evenly spread incl. first and last.
- **Mask inertia** (`maskInertiaFor`) restores coverage: each detection's mask persists ± the
  sampling stride, floored at `GIF_MIN_MASK_INERTIA` to absorb detection jitter. `gifMaskPlayer`
  only consumes it.

The cap shrinks the work; inertia stretches each result to re-cover what the cap skipped.

## Aggregation and verdict

`aggregateGifVerdict()` (pure, `gif/gifVerdict.ts`) combines the per-frame verdicts into one
`IImagePrediction`:

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
