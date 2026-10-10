# Bitstream lookahead analysis replaces the continuous DVR

Status: accepted (2026-10-10) — supersedes ADR 0001 and ADR 0002

The continuous DVR (ADR 0001) re-presents every frame on a canvas. On Firefox the main thread
observes only ~24-39 of 60 painted frames per second and pays ~10 ms per frame to read one, so any
re-presenting design halves YouTube 1080p60 playback. The cost is cross-process frame access and
frame-observability, not computation, so neither WebAssembly nor workers can recover it. A halved
frame rate is not acceptable on any terms.

We decided to leave the page's `<video>` presenting natively (picture and audio untouched) and move
analysis **ahead of the playhead**: the encoded media is read as a bitstream — MSE
`SourceBuffer.appendBuffer` captured by a main-world hook, progressive files and native HLS fetched
by the background — sampled frames are decoded and inferred outside the page, and their verdicts
fill the Verdict Timeline before the playhead reaches them. Masks are an overlay keyed on the
video's media time. Sources with no reachable bitstream (`srcObject` streams, MSE in a page worker,
a failed hook) fall back to **live masking**: sampling page pixels at the playhead and masking
behind it, accepting a short leak when content turns unsafe. Live masking is also the answer
whenever the playhead overtakes lookahead coverage (play start, seek, slow decode) — not a whole
blur and not a pause — so both write the same Verdict Timeline and the playhead is never left
without a verdict source.

## Considered Options

- **Keep the DVR, optimise presentation** (WebGPU external textures, GPU capture, encoded-only
  ring): measured to ~37 fps on Firefox YouTube 1080p60 at best; still re-presents.
- **WebAssembly / worker offload**: the costs are pixel access and the browser's frame-notification
  rate; `<video>` is main-thread-only, `SharedArrayBuffer` needs cross-origin isolation that pages
  lack, and content-script workers are blocked by page CSP/Trusted Types.
- **Twin `<video>` playing ahead**: works for direct `src` but cannot attach to an MSE source.
- **WebRTC loopback with a jitter-buffer delay** / **MediaRecorder into an MSE overlay**: re-encode
  quality loss, the latter stalled at 0.51x when measured.
- **Whole-blur or allow as fallback**: rejected for live masking — some protection beats none, and
  whole-blurring unreadable videos breaks too much content.

## Consequences

No Presentation Delay: no pinned start, the seek bar matches the picture, live streams stay near
live, and delayed-audio routing (delay line, Relay Audio) is unnecessary. Analysis never reads page
pixels on the lookahead path, so canvas taint stops mattering there. A main-world script hooks page
MSE objects (page-visible, fragile against player changes); demuxers for MP4/fMP4/WebM (later TS)
are needed; DRM sources stay unanalysable. Live-masking fallback leaks for about one sampling
interval plus a round-trip when content turns unsafe.
