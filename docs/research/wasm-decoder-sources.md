# WASM decoder sources for VP9 and AV1 (wayfinder ticket 01)

Date: 2026-10-17. Question: which WebAssembly VP9 and AV1 decoders should back a WASM `DecoderPort`
(`utils/lookahead/ports.ts`; native impl `utils/lookahead/webCodecsDecoder.ts`) for Firefox for
Android, where WebCodecs has no decoders (ADR 0003)? ADR 0005 does not exist on any branch
(`feat/wasm-video-decoder-android` is at master); proceeded without it.

## Recommendation

Build our own from upstream release tags: **dav1d (AV1) + libvpx (VP9) via Emscripten, one thin C
shim, single-threaded, `-msimd128`**, loaded in a dedicated worker. Use ogv.js's build scripts as
the starting recipe (not as a dependency). Rationale:

- Smallest and simplest: ogv.js's equivalent modules are ~230 KB (VP9) + ~470 KB (AV1) wasm.
- Raw dav1d/libvpx APIs give exact PTS plumbing and planar YUV with no FFmpeg layer.
- Unmodified upstream release tags satisfy AMO's "release versions, no modification" rule; a
  pinned-emsdk Docker build gives the reviewer a rebuild path.
- No off-the-shelf package fits well: ogv.js npm is stale (below) and is a player, not a decoder;
  libav.js is 2.3-3.0 MB, LGPL, and has no prebuilt dav1d variant.
- Threads are not an option on Firefox extension pages (below), so the multithreaded builds that
  make off-the-shelf AV1 viable on desktop are moot; plan for single-thread throughput and measure.

Fallback if the shim/build cost is rejected: libav.js custom variant (`decoder-libvpx_vp9` +
`decoder-dav1d` fragments exist in its repo), possibly via `libavjs-webcodecs-polyfill` for a
near-drop-in `VideoDecoder`.

## Candidates

|             | ogv.js (prebuilt modules)                                                                                                                                       | libav.js (prebuilt variants)                                                                                     | libav.js custom variant                                                                 | Own Emscripten dav1d + libvpx                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VP9 wasm    | 230 KB (245 KB simd)                                                                                                                                            | `webm-vp9`: 3.03 MB wasm (also VP8, demux, filters, encoders)                                                    | fragment `decoder-libvpx_vp9` 247 KiB on top of base (~178 KiB empty + avcodec 157 KiB) | ~230 KB (ogv.js figure for same libs)                                                                                                                                   |
| AV1 wasm    | 407 KB (472 KB simd)                                                                                                                                            | none prebuilt with dav1d; `av1-opus` uses libaom (decoder fragment 1.2 MiB, README: "effectively unusable" slow) | `decoder-dav1d` config exists, size not published                                       | ~410-470 KB (ogv.js figure)                                                                                                                                             |
| SIMD        | separate simd modules in npm 1.9.0; master since 2025-11-05 uses `-msimd128` on all builds (autovectorisation only; dav1d built `enable_asm=false`)             | none (README: dropped because no constituent library supports wasm SIMD)                                         | none                                                                                    | same as ogv.js; upstream dav1d/libvpx have no wasm SIMD asm (dav1d `src/` arch dirs: arm, loongarch, ppc, riscv, x86; libvpx `vpx_dsp`: arm, loongarch, mips, ppc, x86) |
| Threads     | `-mt` modules (SharedArrayBuffer, up to 4 cores)                                                                                                                | `.thr.wasm` opt-in via `yesthreads`                                                                              | dav1d patched to drop pthreads (single-thread)                                          | optional; dav1d upstream supports wasm32 + atomics                                                                                                                      |
| API         | `processFrame(packet)` then `frameBuffer` (Y/Cb/Cr bytes+stride); no PTS carried, caller keeps order                                                            | `ff_init_decoder` + `ff_decode_multi(packets)` returns `Frame[]` with plane layout (offset/stride) and pts       | same                                                                                    | dav1d `Dav1dData.m.timestamp` -> `Dav1dPicture.m.timestamp`; libvpx 1 packet -> <=1 frame in display order. We write the shim                                           |
| Licence     | wrapper MIT; dav1d BSD-2; libvpx BSD-3 + patent grant                                                                                                           | FFmpeg LGPL (statically linked blob, awkward relink story); wrapper 0BSD per README                              | same                                                                                    | BSD-2 / BSD-3 only                                                                                                                                                      |
| Maintenance | npm last release 1.9.0 (2024-04-23); master `package.json` 2.0.0 unreleased; last push 2026-06-23 (Emscripten 6.0.1 compat); 114 open issues; single maintainer | v6.10.9.0 released 2026-08-18 (FFmpeg 9.0); active; single maintainer                                            | same                                                                                    | dav1d pushed 2026-10-07, latest tag 1.5.4; libvpx pushed 2026-10-16, latest tag v1.17.0 (libav.js pins 1.16.0)                                                          |

Other candidates checked and dismissed:

- `dav1d.js` (npm): v0.1.1, latest release over 6 years ago (secondary: registry listing).
- `@saschazar/wasm-avif` and similar AVIF wasm: still-image decoders, no packet API.
- `ffmpeg.wasm`: not investigated in depth; same LGPL/size trade as libav.js with a CLI-shaped API.
- dav1d upstream wasm: ships `package/crossfiles/wasm32.meson` and `wasm64.meson` plus a
  `build-debian-wasm` CI job (Emscripten build + `meson test`). First-party evidence the build is
  supported.

## Firefox constraints

- **CSP**: `wxt.config.ts` already sets
  `extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"`. Sufficient for wasm
  compile in extension pages and in workers they spawn.
- **Wasm SIMD**: MDN BCD `webassembly/fixed-width-SIMD.json`: Firefox 89, Firefox Android 89
  (mirror). Our `strict_min_version` is 142, so no feature detection or non-SIMD fallback is needed
  on the supported baseline. Local `D:\dev\forks\firefox`
  `modules/libpref/init/StaticPrefList.yaml`: no pref gates baseline SIMD; only
  `javascript.options.wasm_relaxed_simd` and `javascript.options.wasm_simd_avx` (x86/x64 only)
  exist. `all.js`: `javascript.options.wasm`, `wasm_baselinejit`, `wasm_optimizingjit` are `true`;
  nothing under `mobile/android/app` overrides them. Caveat: the checkout is sparse (no `js/`), so
  per-architecture SIMD codegen (e.g. 32-bit ARM Fenix) is not verified.
- **Threads (decisive)**: need SharedArrayBuffer with cross-origin isolation. Bugzilla 1673477
  (open, P3): extension pages report `crossOriginIsolated === false`; manifest
  `cross_origin_embedder_policy` / `cross_origin_opener_policy` are not honoured (bug 1750654, open:
  "unexpected property" warning); Rob Wu (latest comments) says process isolation (bug 1827085) is a
  prerequisite, "a heavy lift". A reporter confirms threaded wasm fails in an extension page but
  works on a normal COOP/COEP page. SAB is available only to privileged extensions (bug 1674383) and
  content scripts (bug 2033743). Same on Fenix. Chrome supports the manifest keys, but Chrome has
  native WebCodecs and does not need this path. Conclusion: single-threaded wasm on Firefox; do not
  plan on `-mt` modules.
- **Where it runs**: our Firefox path decodes in the background page
  (`entrypoints/background/services/lookaheadHostService.ts` calls `createWebCodecsDecoder`
  directly); Chrome decodes in the `lookahead-host` iframe (`entrypoints/lookahead-host/main.ts`).
  MDN `background`: Firefox does not support `background.service_worker` and runs
  `background.scripts` as an event page, "as documents", so DOM and Worker APIs are expected; the
  page does not explicitly confirm `Worker` (verify in a spike). Plain `WebAssembly` works directly
  in the event page or iframe; a dedicated worker (script from `moz-extension://`, same CSP) is a
  responsiveness choice so a long software AV1 decode does not block messaging. libav.js defaults to
  worker mode when Workers exist and calls direct mode "synchronous, so usually undesirable".
- **Event-page lifetime**: a long software decode must keep the event page alive (existing
  keep-alive logic applies); not researched here.

## AMO reproducible-source-build rule

- Extension Workshop "Source code submission": source required when code is produced by "any other
  custom tool that takes files, applies pre-processing, and generates file(s)"; reviewers rebuild
  and "There must be no differences"; build tools must be open source and not web-based; default
  reviewer env Ubuntu 24.04 LTS, ARM64, 10 GB RAM, 6 vCPU, Node 24.14.0 / npm 11.9.0; 200 MB source
  cap; lockfiles and a README with build steps required. The page never mentions WebAssembly.
- Add-on Policies s3.1 and s4: code must be reviewable; "Only release versions of third-party
  libraries ... may be included"; "Modifications to these libraries ... are not permitted".
  Implication: build unmodified upstream release tags (dav1d 1.5.x, libvpx v1.1x). libav.js patches
  dav1d (`patches/dav1d.diff`), so it is the worse fit.
- No AMO page covers `.wasm` specifically (2019 Discourse thread has only community replies,
  pointing to uBlock Origin as precedent). Working assumption: a checked-in wasm plus a pinned-emsdk
  Docker build script is acceptable; confirm with AMO reviewers before shipping. Unverified risks:
  reviewer ARM64 host needs an emsdk with linux-arm64 binaries, and bit-identical rebuild depends on
  pinned emsdk/binaryen versions.
- Alternative: vendor unmodified npm release artifacts (ogv.js dist modules, libav.js variants) as
  "released third-party libraries". Cheaper on review but inherits stale-release (ogv) or LGPL/size
  (libav.js) downsides.

## Fit with `DecoderPort`

`decode(job)` receives
`{config, packets: EncodedSample[] (data, key|delta, timestampUs, durationUs), targets: {pointUs, ptsUs}[]}`
and yields only frames whose PTS equals a target PTS. A wasm decoder must: feed packets from the
keyframe in order, carry `timestampUs` per packet, flush at job end (dav1d has frame delay), drop
non-target frames before any YUV copy, then convert target YUV to an `ImageBitmap` at model input
size (RGBA `ImageData` via canvas/OffscreenCanvas; `toModelInputBitmap` currently requires a
`VideoFrame`). `job.config.codec` (`vp09...`, `av01...`) selects the module. H.264 is out of scope
for these two decoders.

## Open items for a spike

1. Measure single-thread SIMD AV1 throughput on a real Fenix device (ogv.js README: single-thread
   AV1 tops out around 360p on a fast desktop).
2. Confirm `new Worker(moz-extension://...)` and wasm compile in the Firefox event page and on
   Fenix.
3. Ask AMO reviewers (or do a trial submission) about wasm + Emscripten build acceptance and arm64
   emsdk.
4. Measure real own-build sizes (figures above are ogv.js's, not ours).

## Sources

- libav.js: https://github.com/Yahweasel/libav.js (README variants; `docs/API.md`;
  `docs/fragment-sizes.csv`; `mk/libdav1d.mk`, `mk/libvpx.mk`, `patches/dav1d.diff`,
  `configs/configs/decoder-dav1d/config.json`); sizes
  https://data.jsdelivr.com/v1/packages/npm/@libav.js/variant-webm-vp9@6.10.9?structure=flat ;
  releases https://api.github.com/repos/Yahweasel/libav.js/releases
- ogv.js: https://github.com/bvibber/ogv.js (README, CHANGES.md, `buildscripts/compileDav1dWasm.sh`,
  `compileVpxWasmMT.sh`, `COPYING`, commit history); dist sizes
  https://data.jsdelivr.com/v1/packages/npm/ogv@1.9.0?structure=flat
- dav1d: https://github.com/videolan/dav1d (`package/crossfiles/wasm32.meson`, `.gitlab-ci.yml`,
  `meson.build`, `COPYING`); libvpx: https://github.com/webmproject/libvpx
- libavjs-webcodecs-polyfill: https://github.com/ennuicastr/libavjs-webcodecs-polyfill
- AMO: https://extensionworkshop.com/documentation/publish/source-code-submission/ ;
  https://extensionworkshop.com/documentation/publish/add-on-policies/ ;
  https://discourse.mozilla.org/t/webassembly-in-webextensions/37238
- Firefox: https://bugzilla.mozilla.org/show_bug.cgi?id=1673477 ;
  https://bugzilla.mozilla.org/show_bug.cgi?id=1750654 ;
  https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background ;
  MDN BCD https://github.com/mdn/browser-compat-data (`webassembly/fixed-width-SIMD.json`,
  `javascript/builtins/SharedArrayBuffer.json`); local mozilla-central
  `modules/libpref/init/StaticPrefList.yaml`, `all.js`
- Repo: `wxt.config.ts`, `utils/lookahead/ports.ts`, `utils/lookahead/webCodecsDecoder.ts`,
  `entrypoints/lookahead-host/main.ts`, `entrypoints/background/services/lookaheadHostService.ts`,
  `docs/adr/0003-withdraw-video-processing-on-firefox-android.md`
