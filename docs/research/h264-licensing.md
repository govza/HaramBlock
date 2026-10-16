# H.264 decode licensing options (wayfinder ticket 02)

Not legal advice. Researched 2026-10-17 against primary sources; unverified points are marked.

## Question

Licensing and patent exposure for shipping H.264 decode in a free browser extension (AMO + Chrome
Web Store), decoding a few sampled frames/s of web video in WASM for on-device classification.

## Findings

### 1. Cisco OpenH264

- Source: BSD-2-Clause, no patent grant in the licence text.
  [LICENSE](https://github.com/cisco/openh264/blob/master/LICENSE)
- Cisco pays the MPEG LA / Via LA royalty only for **its own binary**. "Teams using the source code
  are responsible for paying all applicable license fees"; Cisco "will not be liable for any
  licensing fees incurred by other parties." [FAQ](https://www.openh264.org/faq.html)
- Binary licence conditions ([BINARY_LICENSE.txt](https://www.openh264.org/BINARY_LICENSE.txt)):
  1. Binary must be "separately downloaded to an end user's device" and not integrated with
     third-party software before download. Bundling voids the patent cover.
  2. End user must be able to control (enable/disable) it.
  3. UI must show "OpenH264 Video Codec provided by Cisco Systems, Inc."
  4. Reproduce BSD text + MPEG LA conditions in EULA/licence info.
  - Patent cover is "for the personal use of a consumer"; content providers/broadcasters may need
    their own licence.
- Cisco distributes native module binaries (Firefox uses Mozilla-built ones) per the
  [FAQ](https://www.openh264.org/faq.html). No Cisco-distributed WASM build found. Only community
  Emscripten ports ([openh264-js](https://github.com/ttyridal/openh264-js), unmaintained;
  [W3C list thread](https://lists.w3.org/Archives/Public/public-webassembly/2019Sep/0002.html) on
  NASM obstacles). A self-built WASM is a source build, so no Cisco patent cover.
- Consequence: the only licensed path is the extension downloading a Cisco-built binary at runtime.
  Cisco ships native libs, not WASM, so an extension cannot load them (native messaging would need a
  separate installer). Downloaded WASM would also conflict with store remote-code rules (below).
  Practically unusable. Initial releases were baseline-only per FAQ (current High profile status
  unverified).

### 2. FFmpeg h264 decoder compiled to WASM

- FFmpeg is LGPL-2.1+ (GPL if GPL parts enabled; avoid libx264). Checklist: dynamic linking,
  distribute FFmpeg source (modified or not). FFmpeg states it is not legal advice and that "MPEG LA
  is vigilant and diligent about collecting." [ffmpeg.org/legal](https://ffmpeg.org/legal.html)
- LGPL in WASM: statically linking into one module is the usual grey area (relinking requirement);
  ship FFmpeg source + build scripts and keep the wasm a separate, replaceable file. (Analysis, not
  from a primary source.)
- LGPL licenses copyright only; it grants no patent licence. Patent exposure is independent.
- ffmpeg.wasm wrapper is MIT; its README says nothing on H.264/patents.
  [repo](https://github.com/ffmpegwasm/ffmpeg.wasm)

### 3. Via LA (ex-MPEG LA) AVC/H.264 pool

Current terms ([Via LA AVC terms page](https://www.via-la.com/licensing-2/avc-h-264/), patent list
updated 2026-09-28):

- PC products: unit = decoder, encoder, or both. Units 1-100,000/yr:
  $0 (one legal entity per affiliated group); 100,001-5M: $0.20; 5M+:
  $0.10. Enterprise cap $9.75M/yr from 2017.
- Streaming (OTT etc.) has separate tiers ($100K small tier up to $4.5M); titles of 12 minutes or
  less $0. Irrelevant: we are not a streaming service.
- Licence grants end users use "for personal and consumer (including internal business) purposes
  without remuneration."
- No free/non-commercial/open-source programme listed; page is silent on software decoders and open
  source. "It is up to each user to determine its own licensing needs." The licence text is the only
  definitive statement of terms.
- Not found: Via LA's statement on how many patents remain active or the last expiry date. Core AVC
  patents are old (standard 2003), but the pool still lists active patents as of 2026-09;
  per-country status not verified.
- Implication: a free extension shipping a decoder is nominally a "unit" of decoder software and
  falls under the 100,000 free-unit tier only if installs stay below 100k per year (resets annually)
  and only one entity in the group claims it. Above that, $0.20/unit unless negotiated. Not
  confirmed: whether Via LA treats an extension download as a unit, and whether a signed
  agreement/reporting is required for the free tier (likely). Contact info@via-la.com.

### 4. Other WASM H.264 decoders

| Decoder                                                                               | Licence                         | Limits                                                    | Patent cover             |
| ------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------- | ------------------------ |
| [Broadway.js](https://github.com/mbebenita/Broadway) (Android decoder via Emscripten) | see repo LICENSE (not verified) | no CABAC, no weighted P prediction; Emscripten 1.35       | none stated              |
| [tinyh264](https://github.com/udevbe/tinyh264) (h264bsd fork)                         | Apache-2.0                      | constrained-baseline/baseline only, I/P only, no B-frames | none stated              |
| openh264 / FFmpeg                                                                     | above                           |                                                           | none unless Cisco binary |

Baseline-only decoders fail on most web video (High profile, CABAC, B-frames), so they are not
viable for general web video regardless of licence. All carry the same patent exposure as any
software decoder; a permissive copyright licence does not remove it.

### 5. Store policy

- Chrome Web Store: functionality must be discernible from submitted code; external resources "must
  not contain any logic"; remote execution disallowed except documented APIs.
  [Remotely hosted code](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
  Bundled WASM not mentioned on that page; MV3 CSP floor includes `'wasm-unsafe-eval'`, so packaged
  WASM is supported.
  [CSP docs](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
  A runtime-downloaded WASM decoder (the OpenH264 route) is remote logic: likely rejected.
- AMO: "Add-ons must be self-contained and not load remote code for execution" (4.2); only
  unmodified release builds of third-party libraries (4.8); source + build instructions required for
  machine-generated/minified code (3.1); unmaintained build tools not accepted. No codec/patent
  rules; WASM not mentioned.
  [Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/) Neither
  store screens for patents (inference from absence); risk sits with the developer.
- Precedent: Firefox obtains OpenH264 as a separately downloaded Cisco-built module (FAQ above).
  ffmpeg.wasm is widely shipped; no Via LA enforcement against free extensions found (limited
  search, not verified).

### 6. Alternative: browser's native decoder (WebCodecs)

`VideoDecoder` works in workers and secure contexts; H.264 (`avc1.*`) support depends on browser/OS
and must be probed via `VideoDecoder.isConfigSupported()`
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder/isConfigSupported_static)). The
MDN page excerpt did not give the browser matrix (not verified, e.g. Firefox). The browser vendor
carries the patent licence, so the extension ships no decoder. For frames of the page's own
`<video>`, sampling the playing element (canvas / `createImageBitmap` / `requestVideoFrameCallback`)
needs no decoder at all.

## Risk picture

- Copyright: manageable with FFmpeg LGPL (ship source, separate wasm) or Apache/BSD decoders.
- Patent: any bundled software H.264 decoder in a free extension is unlicensed unless a Via LA
  licence is taken. Free tier (100k units/yr) exists but requires dealing with Via LA; enforcement
  probability low but non-zero, rising with install count. Cisco's cover is unusable for extensions.
- Store: bundled WASM fine; runtime-downloaded decoder is not.

## Recommendation

1. Primary: use the browser's own decoders: sample frames from the playing `<video>` element and/or
   WebCodecs `VideoDecoder` for fetched media bytes. No bundled decoder, no patent exposure for us.
2. Only if raw-bytes decode is unavoidable: FFmpeg h264-only LGPL WASM, bundled (not downloaded),
   source + build scripts published, separate replaceable module; contact Via LA about free-tier
   handling before launch.
3. Drop OpenH264 (runtime-download binary conflicts with store remote-code rules; no Cisco WASM) and
   Broadway/tinyh264 (baseline-only, no patent cover).
4. Get counsel review before shipping option 2.
