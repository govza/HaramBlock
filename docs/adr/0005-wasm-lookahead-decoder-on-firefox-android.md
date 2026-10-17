# WebAssembly lookahead decoder restores video processing on Firefox for Android

Status: accepted (2026-10-17) — supersedes ADR 0003

ADR 0003 withdrew video processing on Firefox for Android because no JS path can read a video frame
there. Two facts in mozilla-central (2026-10-16) keep that true: WebCodecs is `@IS_NIGHTLY_BUILD@`
on Android (`dom.media.webcodecs.enabled`), and even there `VideoDecoder`'s `CanDecode` returns
false under `IsOnAndroid()` (Bug 1840508); page-pixel readback stays blank because
`SurfaceTextureImage::GetAsSourceSurface()` returns `nullptr`, and the newer `AndroidImageReader`
readback is behind `gfx.video.force-aimage-reader-android` (default false) and covers only FFmpeg
decode in the GPU process.

ADR 0003 rejected a WASM decoder as "a full decoder stack" that "cannot cover DRM/MSE paths". ADR
0004 removed most of that objection: the Bitstream Tap already delivers MSE and Progressive Source
bytes, mediabunny already demuxes them, and Lookahead Analysis decodes only sampled frames off the
page — nothing is re-presented. What is missing is a single step: turning a `DecodeJob` into frames
without WebCodecs.

We decided to add a WebAssembly implementation of `DecoderPort` (`utils/lookahead/ports.ts`) and
select the decoder **by capability, not by platform**: WebCodecs when `VideoDecoder` exists and
`isConfigSupported` accepts the config, otherwise the WASM decoder when it ships that codec,
otherwise the job fails as today. The choice is made on a codec string's first Decode Job and reused
for later jobs with that codec. When Firefox enables WebCodecs on Android, those devices move to
native decode with no release from us; desktop gains a fallback for codecs its native stack lacks.

## Decision

- **Decoder selection**: one selecting `DecoderPort` wraps the WebCodecs and WASM decoders and is
  what both hosts (Chrome lookahead iframe, Firefox event page) construct. The analysis core is
  unchanged.
- **Codecs**: VP9 (libvpx) and AV1 (dav1d), both royalty-free. No H.264: an LGPL FFmpeg build would
  settle copyright, but AVC patents go through Via LA, and a per-unit patent licence that does not
  extend to every recipient cannot be combined with GPL-3.0 distribution (§12). H.264 sources the
  native decoder rejects stay unprotected on Android.
- **Output**: the WASM decoder emits 8-bit I420 planes; the worker downscales them (nearest
  neighbour) and converts to RGB (BT.709) in JS, producing the same `BitmapFrame` (`ImageBitmap` at
  model input size, original dimensions kept) as `toModelInputBitmap`. Other pixel formats fail the
  job.
- **Measured** (S21, Fenix Nightly, single-thread SIMD, 720p full-frame decode): AV1 44–45 fps, VP9
  42–49 fps, about 1.5× of 30 fps; 1080p is 0.45–0.66×, so Keyframe Points only. Scalar builds run
  at about 0.9×, so SIMD is required.
- **Loading**: the WASM modules run in one dedicated worker, created only on the first job native
  decode rejects. They ship in the package; desktop users whose native decoder takes every job never
  instantiate them.
- **Capability**: `videoProcessingAvailable` (ADR 0003) becomes a video capability with two states —
  full (lookahead + Live Masking) and lookahead-only. Firefox for Android resolves to
  lookahead-only: Live Masking stays disabled because page readback is still blank, and sessions
  start with no adoption blur. The popup always shows the video target.
- **Coverage without Live Masking fails open**: where no lookahead verdict covers the playhead (play
  start, seek past coverage, decode behind, no tap), a lookahead-only video plays unmasked. Blurring
  every gap would make seeking and untapped players unusable on mobile, the harm ADR 0003 rejected.
- **Desktop**: in scope only as the fallback path when native decode rejects a job.

## Considered Options

- **Keep the withdrawal, wait for Bug 1840508** — no protection on Android for an unknown period.
- **Remote shared verdict cache** (ADR 0003's future direction) — needs a server and does not
  analyse uncached videos; complementary rather than competing.
- **Platform switch instead of per-job capability** — simpler, but would need a release to adopt
  native WebCodecs and gives desktop no codec fallback.
- **FFmpeg.wasm as one bundle** — broader codec coverage, but larger, slower to instantiate, and
  pulls in H.264 licensing.

## Consequences

Android regains video protection for tapped, unencrypted 8-bit 4:2:0 VP9 and AV1 sources, at a CPU
and battery cost proportional to sample density and GOP length (each sample decodes from its
keyframe). DRM (EME) media, H.264, high-bit-depth or non-4:2:0 streams and untapped sources stay
uncovered. The package grows by the WASM decoders, and AMO review requires reproducible source
builds for them. Desktop behaviour is unchanged unless native decode rejects a codec.
