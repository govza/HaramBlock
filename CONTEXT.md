# HaramBlock

A browser extension for gaze protection: on-device AI detects awrah in images, GIFs, and video
frames as the user browses, and masks it before it is seen.

## Language

### Media Analysis

**Verdict**: The final safe/unsafe decision for a piece of media, produced by aggregating one or
more predictions. _Avoid_: result, outcome, classification

**Prediction**: The model's detections for a single inferred input (one image, one GIF frame, one
video frame). _Avoid_: inference result, detection set

**Fail-closed**: The protection stance while a verdict is genuinely pending: the media stays masked
rather than being revealed. When analysis is permanently impossible, the media is allowed instead
(inference-impossible is not evidence of unsafe content). _Avoid_: fail-safe (ambiguous about
direction)

### Video Processing

**VideoSession**: The binding of one video element to one resolved source. Born when the pipeline
adopts a video whose source is resolved; dies when the source changes or the element is removed.
Pauses, replays, and seeks all happen inside a single VideoSession. _Avoid_: playback session,
playback run

**Thumbnail**: The first-pass input for a video's initial verdict — its poster image, or its first
frame when no poster exists. Analyzed before any playback. _Avoid_: poster (that is only one source
of a thumbnail)

**Frame Sample**: A single playback frame captured from a video and sent for inference. Frame
Samples are ordered within their VideoSession by a monotonic capture counter. _Avoid_: frame grab,
screenshot

**Stale Prediction**: A prediction that must not be applied: it belongs to a dead VideoSession, or
an older Frame Sample than one already applied. _Avoid_: late result, outdated frame

**DVR**: The delayed-presentation mode for masked playback: the video element keeps decoding while a
canvas presents buffered frames one Presentation Delay behind the live edge, compositing frame and
mask in the same draw. _Avoid_: canvas player (that is the GIF mechanism), delay overlay

**Presentation Delay (D)**: How far behind the live edge the DVR presents, sized so a frame's
verdict resolves before the frame is shown. _Avoid_: lag, latency (those describe the problem, not
the mechanism)

**Inertia Window**: The span of media time around a Frame Sample over which its verdict applies
during DVR presentation, derived from the observed sampling cadence. The video analog of GIF mask
inertia. _Avoid_: tolerance, slack
