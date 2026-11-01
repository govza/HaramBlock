# Bundle an H.264 WebAssembly decoder despite unlicensed AVC patents

Status: accepted (2026-11-01) — supersedes the H.264 exclusion of ADR 0005

ADR 0005 shipped VP9 and AV1 WASM decoders for Firefox for Android and left H.264 out over AVC
patents. That leaves the commonest web codec unprotected there: Reddit (`v.redd.it`) serves only
H.264 (Main up to 720p, High at 1080p), so its videos play unmasked. Firefox itself still cannot
help: on Fenix Nightly 161 (S21) WebCodecs rejects video under `IsOnAndroid()`, and page-pixel
readback stays blank with and without `gfx.video.force-aimage-reader-android`.

We decided to bundle FFmpeg's `h264` decoder (LGPL-2.1+, `n9.0.2`, decoder and parser only) as a
third module behind the same `dec_*` interface and capability-based selection. It is chosen per
codec string only when native WebCodecs rejects the config, so when Firefox enables H.264 in
WebCodecs on Android those devices move to native decode with no release from us. Desktop browsers
whose WebCodecs accepts H.264 never instantiate it; ones that lack it (e.g. Chromium without
proprietary codecs) get the same WASM fallback, as ADR 0005 intends. Only profiles that decode to
8-bit 4:2:0 (Baseline, Main, Extended, High) are routed to it; High 10, 4:2:2 and 4:4:4 codec
strings are rejected up front and fail open. We accept the unlicensed AVC patent exposure (Via LA's
pool is still active) as a deliberate risk for a small free extension; the GPL-3.0 §12 conflict ADR
0005 cited arises only from taking a per-unit patent licence, which we do not.

## Considered Options

- **Wait for Firefox** (WebCodecs Bug 1934008, AImageReader readback) — no target release; Reddit
  stays unprotected meanwhile.
- **OpenH264 (BSD-2)** — smaller build, but less battle-tested on Main/High streams; Cisco's royalty
  coverage applies only to its own native binaries, so it carries the same patent exposure.

## Consequences

Measured (S21, Fenix Nightly 161, single-thread SIMD, full-frame decode in a worker of the shipped
modules, same source clip as ADR 0005; VP9 re-measured alongside): H.264 720p Main 129 fps (4.3× of
30 fps), 1080p High 62 fps (2.1×), against VP9 720p 46 fps and 1080p 15–23 fps. Sustained load
throttles the phone to roughly half (H.264 720p 72 fps, VP9 720p 27 fps on repeat runs), so H.264
still stays above real-time at both sizes and needs no reduced sampling.

The package grows by about 1.5 MB of WASM. A stream that mislabels its profile and decodes to
another pixel format fails its job, which fails open.
