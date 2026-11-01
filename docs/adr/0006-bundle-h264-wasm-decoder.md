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
WebCodecs on Android those devices move to native decode with no release from us, and desktop never
instantiates it. We accept the unlicensed AVC patent exposure (Via LA's pool is still active) as a
deliberate risk for a small free extension; the GPL-3.0 §12 conflict ADR 0005 cited arises only from
taking a per-unit patent licence, which we do not.

## Considered Options

- **Wait for Firefox** (WebCodecs Bug 1934008, AImageReader readback) — no target release; Reddit
  stays unprotected meanwhile.
- **OpenH264 (BSD-2)** — smaller build, but less battle-tested on Main/High streams; Cisco's royalty
  coverage applies only to its own native binaries, so it carries the same patent exposure.

## Consequences

The package grows by about 1.5 MB of WASM. H.264 follows the existing sampling rules (1080p at
Keyframe Points); High 10 and non-4:2:0 streams fail the job, which fails open.
