# HaramBlock

A browser extension for gaze protection: on-device AI detects awrah in images, GIFs, and video
frames as the user browses, and masks it before it is seen.

## Language

**Verdict**: The final safe/unsafe decision for a piece of media, produced by aggregating one or
more predictions. _Avoid_: result, outcome, classification

**Prediction**: The model's detections for a single inferred input (one image, one GIF frame, one
video frame). _Avoid_: inference result, detection set

**Fail-closed**: The protection stance while a verdict is genuinely pending: the media stays masked
rather than being revealed. When analysis is permanently impossible, the media is allowed instead
(inference-impossible is not evidence of unsafe content). _Avoid_: fail-safe (ambiguous about
direction)

Video-processing vocabulary (VideoSession, Thumbnail, Frame Sample, Stale Prediction, DVR,
Presentation Delay, Inertia Window) lives in [VIDEO_PROCESSING.md](VIDEO_PROCESSING.md).
