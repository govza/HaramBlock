# Withdraw video processing on Firefox for Android

Status: accepted (2026-08-21)

On Firefox for Android (Fenix), the video pipeline was actively harmful: videos on processed pages
rendered as a solid black rectangle with audio still playing, or briefly blurred and then played
with a false "safe" status. Diagnosis over Firefox RDP on a physical device (Fenix 156 / Android 15)
confirmed the root cause in Gecko: hardware-decoded video frames are wrapped in an opaque surface
whose readback deliberately returns nothing (`SurfaceTextureImage::GetAsSourceSurface()` returns
`nullptr`). Every JS capture path - `drawImage`, `createImageBitmap`, WebGL `texImage2D`,
`captureStream`, WebCodecs `VideoFrame` - silently yields empty pixels with no error. Additionally,
WebCodecs has zero registered encoders/decoders on Fenix:
`VideoEncoder`/`VideoDecoder.isConfigSupported` return false for every codec and acceleration
combination, and a constructed `VideoFrame` has correct geometry but `format: null` and no surface
data. The DVR therefore presented an empty canvas over a hidden video element (black screen), and
inference classified blank frames as safe (false "safe" verdicts). The DVR canvas measured fully
transparent while the video element sat at opacity 0 with a safe status attribute. There is no
content-side workaround. The blur seen on Shorts source switches was the intentional initial
adoption blur (~800 ms), not slow inference - a red herring.

## Decision

- **Withdraw video processing entirely on Firefox for Android.** Videos play natively, untouched -
  never hidden, blurred, adopted, or styled. Blacklist behaves as allow for video. Images and GIFs
  are unaffected (canvas readback of images is healthy on Fenix).
- **One capability flag**: `videoProcessingAvailable` (`utils/capabilities/videoProcessing.ts`),
  false exactly when the browser is Firefox and
  `browser.runtime.getPlatformInfo().os === 'android'`. No user-agent sniffing. Resolved once in the
  background at startup, cached in `browser.storage.local` so document-start content code can read
  it with a fast local get. On the very first run before the cache exists, the pre-settings
  bootstrap may briefly behave as today; this interval is accepted.
- **Content gating at discovery** (`entrypoints/content/core/mediaRouting.ts`): when the flag is
  false, discovered videos are never routed anywhere - no VideoSession adoption, no adoption blur,
  no pending-source blur, no bootstrap/discovery-guard hiding, no blacklist styling. The video
  pipeline below discovery is untouched.
- **UI gating**: the policy target switcher (shared by popup and options overview) does not render
  the `video` target when the flag is false. No explanatory note. `PolicyTarget` and stored settings
  are unchanged; a synced video-enabled policy is silently inert on Android.
- **Scope**: Firefox for Android only. Chromium-based Android browsers are not a target of this
  repo.

## Considered Options

- **WASM software decode in the content script** - rejected: shipping a full decoder stack to work
  around platform readback is enormous complexity and battery cost for mobile, and cannot cover
  DRM/MSE paths.
- **about:config software-decode workaround** - rejected: requires per-user manual configuration of
  a hidden pref, unsupportable at scale, and regresses playback performance and battery.
- **Blur everything (fail closed)** - rejected: permanently breaks all video playback on mobile,
  worse than the harm being fixed.
- **Black-frame detection guard** - rejected: heuristics on top of a capture path that is known to
  always return blank frames add complexity to detect a condition this withdrawal makes structural.

## Consequences

Firefox for Android users get native video playback and honest status reporting: the extension never
claims a video is analyzed or safe when it saw no frames. Image and GIF protection continue
unchanged. Desktop Firefox and Chrome video processing are unaffected. Android devices carry no
video protection until a platform-independent path exists: the designated future direction is a
remote shared verdict cache - on-demand server-side analysis keyed by page URL / video ID, with
allow-on-uncovered semantics - which restores protection without any frame capture on the device.
That service is out of scope here and intentionally not spec'd.
