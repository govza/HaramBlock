# WebAssembly lookahead decoder restores video processing on Firefox for Android

Status: proposed (2026-10-17) — would supersede ADR 0003

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
select the decoder **per Decode Job by capability, not by platform**: WebCodecs when `VideoDecoder`
exists and `isConfigSupported` accepts the config, otherwise the WASM decoder when it ships that
codec, otherwise the job fails as today. When Firefox enables WebCodecs on Android, those devices
move to native decode with no release from us; desktop gains a fallback for codecs its native stack
lacks.

## Decision

- **Decoder selection**: one selecting `DecoderPort` wraps the WebCodecs and WASM decoders and is
  what both hosts (Chrome lookahead iframe, Firefox event page) construct. The analysis core is
  unchanged.
- **Codecs**: VP9 (libvpx) and AV1 (dav1d) first — what YouTube serves to Firefox. H.264 is deferred
  until its patent/licensing position is settled.
- **Output**: the WASM decoder emits YUV planes; a WASM-side downscale + YUV→RGB step produces the
  same `BitmapFrame` (`ImageBitmap` at model input size, original dimensions kept) as
  `toModelInputBitmap`.
- **Loading**: the WASM module is a lazily imported chunk loaded only on the first job native decode
  rejects. It ships in the package; desktop users never fetch or instantiate it.
- **Capability**: `videoProcessingAvailable` (ADR 0003) becomes a video capability with three states
  — full (lookahead + Live Masking), lookahead-only, none. Firefox for Android resolves to
  lookahead-only: Live Masking stays disabled because page readback is still blank.
- **Coverage without Live Masking fails open**: where no lookahead verdict covers the playhead (play
  start, seek past coverage, decode behind, no tap), a lookahead-only video plays unmasked. Blurring
  every gap would make seeking and untapped players unusable on mobile, the harm ADR 0003 rejected.
- **Desktop**: in scope only as the fallback path when native decode rejects a job.
- **Battery**: a lower default sample density on lookahead-only devices (Keyframe Points or level-0
  lattice only), tunable later.

## Considered Options

- **Keep the withdrawal, wait for Bug 1840508** — no protection on Android for an unknown period.
- **Remote shared verdict cache** (ADR 0003's future direction) — needs a server and does not
  analyse uncached videos; complementary rather than competing.
- **Platform switch instead of per-job capability** — simpler, but would need a release to adopt
  native WebCodecs and gives desktop no codec fallback.
- **FFmpeg.wasm as one bundle** — broader codec coverage, but larger, slower to instantiate, and
  pulls in H.264 licensing.

## Consequences

Android regains video protection for tapped, unencrypted VP9/AV1 sources, at a CPU and battery cost
proportional to sample density and GOP length (each sample decodes from its keyframe). DRM (EME)
media, untapped sources and H.264 stay uncovered. The package grows by the WASM decoders, and AMO
review requires reproducible source builds for them. Desktop behaviour is unchanged unless native
decode rejects a codec.
