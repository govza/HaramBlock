# Video Processing Architecture

This document describes how HaramBlock detects, analyses, and masks `<video>` content — the
architecture, the vocabulary, and the design decisions behind it. General (non-video) vocabulary
(Verdict, Prediction, Fail-closed) is defined in [MEDIA_PROCESSING.md](MEDIA_PROCESSING.md). The
governing decision is ADR [0004](adr/0004-bitstream-lookahead-replaces-continuous-dvr.md), which
superseded the continuous DVR (ADRs [0001](adr/0001-continuous-dvr-and-relay-audio.md),
[0002](adr/0002-direct-url-relay-audio-and-machine-owned-audio-route.md)).

## Vocabulary

**VideoSession**: The binding of one video element to one resolved source. Born when the pipeline
attaches to a video whose source is resolved; dies when the element is removed or its source changes
to different media. A new source with an equal stable or local Video Identity (a direct file whose
signed-URL tokens rotated) continues the session: Verdict Timeline, status and blur are kept and
only the tap is re-opened; a finite duration that then differs by more than 1 s restarts it as new
media. An unknown identity never continues another source's media. Pauses, replays, and seeks all
happen inside one VideoSession. _Avoid_: playback session

**Video Identity**: What names a VideoSession's media for the verdict cache, independent of the
page, rendition or URL spelling. `stable`: a portable `namespace:id` key with the media duration
(`url:` plus the direct file URL without allowlisted auth params; site adapters add `yt`, `vreddit`,
…). `local`: `page:<page URL without fragment>|d=<duration in 100 ms>` for MSE sources no adapter
identifies — persistent on this device, never shared. `unknown`: no duration yet, a `srcObject`
stream, a live stream or an adapter's veto (an ad) — analysed and masked in memory only, never read
from or written to the cache. Resolved by `identityResolver.ts` (site adapters first, by page
location, then `genericIdentityRules.ts`) when the source resolves and again on `loadedmetadata` /
`durationchange`; the first stable or local identity is kept for the session. _Avoid_: cache key,
video URL

**Thumbnail**: The first-pass input for a video's initial verdict — its poster, or its first frame
when no poster exists. Analysed before any playback. _Avoid_: poster (only one source of it)

**Bitstream Tap**: The source of a video's encoded media for Lookahead Analysis — the MSE append
hook (`mse`) or a cookie-less range fetch of a Progressive Source (`progressive`). No tap (`none`)
means Live Masking for the whole session. _Avoid_: stream hook, demuxer

**Lookahead Analysis**: Decoding a few frames per second of the encoded bitstream ahead of the
playhead, off the page, and inferring them so verdicts exist before the native element paints the
frames they describe. _Avoid_: prefetch, DVR

**Live Masking**: Sampling page pixels at the playhead whenever no lookahead verdict covers it (play
start, a seek past coverage, analysis falling behind) or no tap is reachable. Masks land just behind
the playhead; a short leak when content turns unsafe is accepted. _Avoid_: realtime mode

**Analysis Unit**: One top-level WebM Cluster or one fMP4 `moof`…`mdat` pair of an MSE Source, cut
from each SourceBuffer's byte stream (not from appends) and demuxed as init segment + unit. _Avoid_:
segment, chunk, append

**Sample Lattice / Lattice Point**: The fixed media times every client samples at: level 0 every 0.5
s, each further level halving the spacing down to 250 ms; levels nest. A Lattice Point is one such
time in integer µs; its sample describes the frame presented at that time (the last frame with PTS ≤
t, in page media time). _Avoid_: grid, cadence, tick

**Keyframe Point**: On a long-GOP Progressive Source, a Keyframe's PTS rounded up to the next µs,
used instead of Lattice Points so samples never pay a GOP Prefix download each. _Avoid_: keyframe
sample

**Refinement Probe**: A sample on a finer lattice level: at the midpoint between two neighbouring
stored samples that disagree (down to 250 ms), or half the sample's own lattice spacing on each side
of a Suspicious Clean sample. Both plans derive from stored labels and scores only, so every reader
of the same samples plans the same probes. _Avoid_: bisection sample

**Suspicious Clean**: A clean sample whose top unsafe score is at least the suspicion threshold
(half the reader's own score threshold) but below the threshold itself. _Avoid_: near miss

**Verdict Timeline**: The session-lifetime, media-time-keyed sample history
(`timeline/verdictTimeline.ts`). Lookahead, cached and Live Masking samples are indistinguishable in
it; two samples at the same media time keep the unsafe one. _Avoid_: verdict track

**Verdict Interpreter**: The only reader of the Verdict Timeline (`timeline/verdictInterpreter.ts`).
It answers "what covers the frame presented at media time t" for the Mask Presenter, under the rule
of the session's current mode (Live Masking or lookahead). Every unsafe sample masks: there is no
post-inference suppression. _Avoid_: verdict filter

**Bridge Horizon**: How far ahead an upcoming unsafe sample still merges its mask geometry into the
cover of the current frame (3 s).

**Loop Wrap / Loop Restart**: A Loop Wrap is a backward jump of more than half the duration in a
looping video's media time. A Loop Restart is a `seeked` that is the browser's own Loop Wrap (both
ends within 0.5 s × playback rate of the edges); it keeps coverage instead of re-entering Live
Masking like a seek.

**Mask Presenter**: The overlay above the natively playing video that shows the masks covering its
extrapolated playhead (`presenter/maskPresenter.ts`). _Avoid_: DVR, canvas player

## Overview

The page's `<video>` plays natively and untouched — its own frame rate, no delay, page-owned audio.
For every attached video:

1. The registry chooses a Bitstream Tap from the resolved source (`tap/tapChoice.ts`): a `blob:` URL
   → MSE; an `http(s)` URL → progressive; `srcObject`, native HLS (`.m3u8`), `data:` and anything
   else → none.
2. Lookahead Analysis (`utils/lookahead/`) reads the tap, decodes sampled frames off the page, and
   sends them through the shared inference pipeline. Each sample fills the Verdict Timeline.
3. The Mask Presenter runs on rAF, asks the Verdict Interpreter what covers the extrapolated
   playhead, and shows or hides a compositor-only overlay.
4. Live Masking samples page pixels whenever coverage ahead of the playhead runs short, or for the
   whole session when no tap is reachable.

Before a VideoSession exists, document-start bootstrap styles hide light-DOM videos and Reddit's
`<shreddit-player>` host until discovery has applied blacklist styling or the attachment blur, then
`data-haramblock-video-discovered` reveals them.

On Firefox for Android the video capability is `lookahead-only` (ADR
[0005](adr/0005-wasm-lookahead-decoder-on-firefox-android.md)): page pixels of a video read back
empty there, so sessions are born with pixels unreadable — no bootstrap hiding, no attachment or
pending-source blur, no Live Masking, Thumbnail from the poster only — and every gap in lookahead
coverage fails open. Decode Jobs go to native WebCodecs when it accepts the config, otherwise to the
bundled WebAssembly decoders (VP9, AV1) in a dedicated worker.

## Components

| Component             | File                                                                                                                                         | Role                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Video Session reducer | `entrypoints/content/video/session/videoSession.ts`                                                                                          | Pure `(state, event) → (state, effects)`; no DOM, timers or transport                                      |
| Registry              | `entrypoints/content/video/session/registry.ts`                                                                                              | Session lifecycle, media events, result routing, effect execution, telemetry                               |
| Viewport suspension   | `entrypoints/content/video/session/viewportSuspension.ts`                                                                                    | IntersectionObserver suspend/resume (400 px margin, 1 s grace)                                             |
| Forced presentation   | `entrypoints/content/video/session/forcedPresentation.ts`                                                                                    | Quick Toggle overrides (Forced Visibility) with no session behind them                                     |
| Mask Presenter        | `entrypoints/content/video/presenter/{maskPresenter,presentationClock,maskClipPath}.ts`                                                      | rAF overlay, extrapolated playhead clock, mask grid → `clip-path`                                          |
| Live Masking sampler  | `entrypoints/content/video/live/liveSampler.ts`                                                                                              | rVFC/rAF ticker, one sample in flight, 250 ms floor, paused-frame samples                                  |
| Page capture          | `entrypoints/content/video/sampling/capture.ts`                                                                                              | Model-input-sized capture, poster extraction, CORS clone and Relay Fetch tiers                             |
| Verdict Timeline      | `entrypoints/content/video/timeline/{verdictTimeline,verdictInterpreter}.ts`                                                                 | Sample history, coverage ahead, per-frame cover lookup per mode                                            |
| Lookahead client      | `entrypoints/content/video/tap/lookaheadClient.ts`                                                                                           | Hook handshake, host connection (Chrome iframe / Firefox port), cache and inference forwarding             |
| MSE hook              | `entrypoints/mseHook.content.ts`, `utils/lookahead/mseHook.ts`                                                                               | MAIN-world `MediaSource` / `SourceBuffer` hook at `document_start`                                         |
| Analysis core         | `utils/lookahead/{analysis,byteStream,demux,lattice,progressiveFile}.ts`                                                                     | DOM-free: unit cutter, mediabunny demux, Sample Lattice, scheduling, cache-first lookup, Refinement Probes |
| Host runtime          | `utils/lookahead/{host,webCodecsDecoder,rangeFetchSource,protocol}.ts`                                                                       | Source registry and per-session analyses; WebCodecs decode; range fetch; wire protocol                     |
| WASM decoders         | `utils/lookahead/{decoderSelection,wasmDecoder,wasmDecodeCore,yuvToRgba}.ts`, `entrypoints/wasm-decoder-worker.ts`, `scripts/wasm-decoders/` | Per-job choice native → WASM; worker decode and YUV → model-input bitmap; reproducible Emscripten builds   |
| Chrome host           | `entrypoints/lookahead-host/`                                                                                                                | Hidden extension iframe running the host runtime                                                           |
| Firefox host          | `entrypoints/background/services/lookaheadHostService.ts`                                                                                    | Host runtime in the event page, fed over `runtime.connect`                                                 |
| Identity resolver     | `entrypoints/content/video/identity/{identityResolver,genericIdentityRules}.ts`, `utils/videoIdentity.ts`                                    | Video Identity from site adapters, then generic rules; same-media and duration-mismatch rules              |
| Verdict cache         | `entrypoints/background/services/videoPredictionCacheService.ts`, `utils/db/videoPredictionRepository.ts`                                    | Buffered persistence of raw-score samples: meta row + 5-minute bucket rows                                 |
| Sample scores         | `utils/lookahead/sampleScores.ts`, `utils/scoreGrid.ts`                                                                                      | Raw floor scores → predictions / unsafe under the reader's threshold; suspicion threshold                  |
| Discovery             | `entrypoints/content/core/VideoProcessor.ts`                                                                                                 | Blacklist styling or registry attachment                                                                   |

## The Video Session reducer

`videoSession.ts` is a pure reducer: no DOM, timers or transport.

- **Events**: `tapReachable`, `tapUnreachable`, `sourceChanged{coverageAheadSec}`, `play`,
  `pause{covered}`, `seeked{paused, covered}`, `loopRestarted`, `progress{coverageAheadSec}`,
  `verdict{sampleId}` (lookahead or cache), `thumbnailVerdict{unsafe}`, `liveSample{sampleId}`,
  `liveCaptureFailed{permanent}`, `presented{unsafe}`, `visibility{visible}`, `dispose`.
- **Effects**: `applyBlur`, `clearBlur`, `startLiveMasking`, `stopLiveMasking`, `requestLiveSample`,
  `reopenTap`, `commitSample` (move a held sample into the Verdict Timeline), `setStatus`,
  `cleanup`.
- `verdictOptionsOf(state)` hands the Verdict Interpreter the session's mode: Live Masking or
  lookahead.

Rules:

- **Live Masking hand-off**: on while the tap is pending or unreachable; with a reachable tap it
  starts when coverage ahead drops under `LIVE_MASKING_START_COVERAGE_SEC` (1.5 s) and stops only at
  `LIVE_MASKING_STOP_COVERAGE_SEC` (5 s). A real seek resets coverage to 0 until the next
  `progress`; a Loop Restart does not. Offscreen sessions and unreadable page pixels never
  live-mask.
- **Initial blur**: the attachment blur stays only until the first verdict of any kind (Thumbnail,
  lookahead, cache or live). The uncovered playhead before any live verdict plays unmasked — the
  accepted leak.
- **Live samples** commit to the Verdict Timeline as they arrive, whatever their confidence.
- **Status** flips to unsafe when the presenter reports an unsafe span (or unsafe Thumbnail)
  presented, not when its verdict arrives ahead, and is sticky: it never returns to `safe`, and a
  later `skipped` doesn't replace it. The registry remembers unsafe Video Identity keys for the
  page's lifetime (`createVideoSession({ unsafeSeen })`), so the same media stays unsafe across a
  Forced Visibility round-trip, re-attach or loop; sources with an unknown identity are sticky per
  session only.
- **Paused frames**: a pause or paused seek on an uncovered frame requests one live sample.
- **Unreadable page pixels** (permanent capture failure): with no tap, the session finalises
  `skipped` and un-blurred; with a tap, Live Masking stops, uncovered spans play un-blurred until
  lookahead covers them, and status follows the presented spans.

## Bitstream Taps and hosts

### MSE hook

A MAIN-world content script (`world: 'MAIN'`, `document_start`, all frames) wraps
`URL.createObjectURL` (to map a `MediaSource` to its `blob:` URL), `addSourceBuffer` /
`removeSourceBuffer`, `SourceBuffer.appendBuffer`, `changeType`, and `appendEncodedChunks` when
present. Completion is tracked on `update`, registered inside `addSourceBuffer` before the page sees
the SourceBuffer; each completed append's `slice()` is transferred (never copied again) with the
`timestampOffset` read at append time; `abort`/`error` drop it. ArrayBuffers are recognised by type
tag, not `instanceof`. A quality switch is a new `MediaSource`, hooked like any other. YouTube's
player response marks live and post-live DVR sources; after SPA navigation the response can still
describe the previous video, so it is trusted only when its `videoId` matches the playing video
(`getVideoData()`, else the page URL). Until it does the source's liveness is `unknown`, re-read on
each append, and announced (`liveness`) once known. Every hook body is guarded so a failure can
never break the page's player.

The hook and the isolated content script start in unspecified order, so they handshake over
`window.postMessage`: the hook announces `ready`; the content script offers a `MessagePort` (`port`)
eagerly and again on `ready` until the hook answers `ack`. The hook and port are page-visible;
spoofed bytes are an accepted risk.

Bytes are pulled, not pushed: the hook announces every source (`source`: id, object URL, liveness)
at once, but streams a source's buffer, append and chunk messages only after the host sends `want`
for it over the same port, and stops again on `drop`. Until then it records them per source, bounded
at 48 MB. Before a source's first `want` nothing is evicted: a backlog that outgrows the cap is
dropped whole, recording stops, and the next `want` is answered with `overflow`, which the host
reports as unreachable (`overflow`) — Live Masking rather than analysis with holes. A source that
was wanted and then dropped (its host keeps the resumable unit cutters and init segments) instead
evicts its oldest appends past the cap and flags the next append of that buffer `discontinuity`, so
the cutter resynchronises at the next WebM Cluster or fMP4 `moof`; an evicted append that carried an
init segment leaves its init bytes behind. A newly adopted port keeps each source's resumability,
but its new host never saw what went to the old port: on the first `want` over the new port the hook
re-sends each live buffer's `buffer` message (with its current mime) and its latest init segment
(the EBML header up to the first Cluster, or the `ftyp`/`moov` boxes before the first media box,
kept from the appends that carried them), then flags that buffer's next append — recorded or live —
`discontinuity`. On Firefox the content script offers the hook a fresh port as soon as the event
page's runtime port disconnects, so the hook stops streaming into the dead relay, records again, and
replays its announcements to the next event page; the content script reconnects and re-opens its
sessions (with their last playhead, visibility and liveness) unless the port died within 5 s of
connecting, in which case they are reported unreachable (`hook`). Audio SourceBuffers are announced
but their bytes are never recorded or streamed. A page whose videos are never processed therefore
never ships its media out of the page.

A session that closes and reopens on the same source (a quality switch back, a Forced Visibility
round-trip) does not get the buffer and init messages again: the host keeps the closed analysis's
per-buffer unit cutters (with their init segments) on the source and the next analysis on it resumes
them, resynchronising at the next unit.

### Progressive range fetch

`rangeFetchSource.ts` fetches with `credentials: 'omit'` and `referrerPolicy: 'no-referrer'` in 64
KB blocks; the size comes from the first block's `Content-Range`, so there is no separate probe. A
first request that is not `206`, a `401`/`403`, or a non-media body makes the bitstream unreachable.
mediabunny reads the file through a `CustomSource` over it, so the index is read once and media
ranges only for GOPs that are actually analysed.

### Hosts

| Browser | Host                                                        | Byte ingress                                              | Frame egress                                                                                                                                             |
| ------- | ----------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chrome  | hidden `lookahead-host.html` iframe in a closed shadow root | hook port transferred straight into the iframe            | `createImageBitmap` resized to the model input, transferred to the content script, sent as the `bitmap` video-frame transfer (`sampleKind: 'lookahead'`) |
| Firefox | background event page (`LookaheadHostService`)              | hook → content script → `runtime.connect('hb-lookahead')` | same bitmap handed to `scheduleInferenceTask` in-process with an `onResult` callback; no Blob encode                                                     |

Both run `LookaheadHost` (`utils/lookahead/host.ts`): it maps object URLs to hooked sources, and an
`open` for an MSE Source sends `want` so the hook replays what it recorded and then streams live;
`close` sends `drop`. An `open` for an object URL waits up to 3 s for its source; none means
unreachable (`hook`). Decoding uses WebCodecs (`no-preference` on Chrome, `prefer-software` on
Firefox); decoded `VideoFrame`s are closed right after the bitmap hand-off. On Chrome the host
reaches inference and the cache through the content script (`infer` / `cacheRead` / `cachePublish`
messages); on Firefox it calls the services directly.

## Lookahead Analysis

- **Cutting**: a streaming top-level reader per SourceBuffer (`byteStream.ts`) cuts Clusters (known
  or unknown size) and `moof`+`mdat` pairs across arbitrary append boundaries, and seals a new init
  segment whenever one appears. An unknown-size Cluster ends at the next level-1 element, or at
  `MediaSource.endOfStream()` (streamed by the hook per video SourceBuffer). Each unit is demuxed as
  init + unit with mediabunny; demuxed PTS + the `timestampOffset` of the append that delivered the
  frame's last byte is page media time — never `buffered`. `appendEncodedChunks` groups are analysed
  at the end of each call, not held for the next keyframe; a group continued by the next call is
  re-offered extended.
- **Retention**: decoded frames are closed once their inference settles (or when decoding fails). A
  unit's encoded bytes are released once a later point is analysed, so only the init segment,
  unanalysed units and the newest analysed unit (which a Refinement Probe from the next unit may
  still need) are held.
- **Sampling**: an MSE unit covering `[first PTS, last PTS + duration)` asks for the level-0 Lattice
  Points inside it. A Progressive Source asks, per GOP, for Lattice Points where the GOP is ≤ 1 s
  and its Keyframe Point otherwise, within a 60 s window ahead of the playhead, refilled as it
  advances and paused while offscreen. Refinement Probes beyond the window wait until it reaches
  them. MSE run-ahead is uncapped and driven by appends; units are never dropped unanalysed.
- **Ordering**: the next decode job takes the source holding the earliest point at or after the
  playhead; within it, points at or after the playhead go first in playback order, then the rest. At
  most 6 inferences are in flight.
- **Cache first**: cached samples are loaded before any decode; a cached point is never decoded and
  a fully cached progressive range is never fetched. Refinement Probes missing from cached samples
  are computed and published.
- **Failures**: a unit that fails to demux or a decoder that fails reports the bitstream unreachable
  (`demux` / `decode`) and ends the analysis — Live Masking takes over.

### Priorities

`utils/constants/inference.ts`: `liveFrame` 40, `visibleImage` 30, `lookaheadUrgent` 25 (slack —
time until the playhead reaches the sample — under 5 s), `videoThumbnail` 20, `videoFrame` 10
(lookahead with slack), `offscreenImage` 0 (lookahead while the video is offscreen or the tab is
hidden). The background keeps the one-queued-frame-per-session rule for live frames only.

### Sampling contract and cache

A sample is identified by (video identity, `modelId`, point in integer µs); readers accept a stored
sample only for its exact point. Video frames are inferred at the floor threshold
(`MIN_SCORE_THRESHOLD`, 0.05) whatever the site's strictness, so a stored sample means the same to
every reader: `{ pointUs, scores, input, topUnsafeScore }`, clean samples included. `scores` is raw
— `detections` (instance models, floor detections) or `grid` (semantic models, an `IScoreGrid` of
uint8 value-runs for per-cell probability and class id, `utils/scoreGrid.ts`). `topUnsafeScore` is
the best target-class score. Each reader applies its own strictness on read (`predictionsAt` /
`isUnsafeAt` in `utils/lookahead/sampleScores.ts`) when building the Verdict Timeline and planning
Refinement Probes; the suspicion threshold is `suspicionThresholdOf` (half the reader's threshold).
Changing strictness rebuilds the content pipeline, so new sessions re-read the same samples under
the new threshold; video samples are never cleared for it.

Dexie schema v4 keys the cache by Video Identity (its upgrade drops the v3 page-URL-keyed
`videoPredictions` / `videoSamples` tables). `videos` holds one meta row per stable or local
identity (`identityKey`, `identityKind`, `durationSec`, the last source URL) with the video's Forced
Visibility, cache metadata and `sampleCounts` per model (the Cache Browser lists the identity key
and kind). `videoSampleBuckets` holds the samples in 5-minute media-time buckets keyed
`[identityKey+modelId+bucketStartUs]` (`VIDEO_SAMPLE_BUCKET_US`). There is no per-video sample cap;
expiry follows the meta row's `accessedAt`, and an expired video is purged before a merge. A stored
duration more than 1 s off the playing identity's purges that video's samples (on read and on merge)
and adopts the new duration; its Forced Visibility is kept. `getVideoForcedVisibility` reads the
meta row alone. The service buffers publishes per (video, model) and merges every 2 s or 50 samples;
`getCached` flushes pending writes first. The Verdict Timeline keeps at most 4000 entries and evicts
the one farthest from the playhead; evicted spans are not re-read from the cache.

Live and post-live sessions neither read nor publish; Live Masking samples are never cached. A
session's liveness (`live` / `vod` / `unknown`) combines the hook's YouTube reading with the video's
duration (infinite → `live`, finite → `vod`, unset → `unknown`), re-sent on every `durationchange`.
Samples analysed while it is `unknown` are held, published once it is `vod`, and dropped if it turns
`live`; `live` is final for the session.

The same hold applies to the Video Identity: the analysis opens with the identity known at attach
(`OpenAnalysis.identity`) and receives a later one as an `identity` message. Its single cache read
waits for a stable or local identity, at most 3 s (`IDENTITY_WAIT_MS`), then proceeds without the
cache (analysis is held back meanwhile); samples are published only while liveness is `vod` and the
identity is stable or local, held until then, and dropped if the session ends unidentified.

## Mask Presenter

- Every rAF it computes `currentTime + min(now − lastChangeSeen, 100 ms) × playbackRate`
  (`MAX_EXTRAPOLATION_SEC`), folded modulo the duration for looping videos. It never uses rVFC
  `mediaTime`, which Firefox does not wrap on loop.
- The Verdict Interpreter answers for that time: masks start `PRE_MASK_LEAD_SEC` (one level-0
  spacing, 500 ms) before an unsafe sample, so the whole gap after the last clean sample is covered,
  and end at the clean sample that closes the span (the clean-cut rule, no trailing pad). A sample
  behind the playhead carries forward only within `COVERAGE_MAX_GAP_SEC` (2 s). Under lookahead the
  mask ends exactly at the span end. Under Live Masking asymmetric hysteresis holds it until a
  confirmed clean sample: an unconfirmed clean sample (nothing after it yet, or an unsafe one) keeps
  the mask, and at the frontier or before a coverage hole an unsafe sample holds however late the
  next sample arrives.
- The overlay is a div homed next to the video (by the shared overlay anchor, shadow-DOM aware) with
  `backdrop-filter` built from the host's masking settings and a `clip-path: path()` built from the
  RLE mask grids mapped onto the rendered content rect. No page pixels are read, so presenting costs
  no main-thread draw. An unsafe Thumbnail is shown the same way until playback starts.
- It reports `presented{unsafe}` transitions to the session and feeds `progress` every 250 ms.

## Live Masking

`LiveSampler` ticks on rVFC (rAF fallback), sends one capture at a time no closer than 250 ms
(`SAMPLE_FLOOR_MS`), and frees its slot on the verdict or after 3 s. Captures reuse
`sampling/capture.ts`: model-input-sized bitmaps, the CORS clone tier and the Relay Fetch tier for
cross-origin sources, poster extraction for the Thumbnail. Transfers use the existing video-frame
path (Chrome bitmap over the MessageChannel, Firefox WebP blob) with `sampleKind` `live` or
`thumbnail`.

## DOM markers and status

- `data-hb-video-tap` — `mse`, `progressive` or `none`, set when the tap resolves; `progressive`
  only once the first range request succeeds.
- `data-hb-session-id`, `data-hb-src` — the session binding (also used by the predecessor sweep).
- `data-haramblock-processed-safe | -unsafe | -skipped` — exactly one after the first verdict;
  `skipped` only for unreadable page pixels with no tap. All are removed on disposal.
- `[data-video-mask-overlay="video-mask-presenter"]` — the presenter overlay (`display:none` while
  nothing is masked). The attachment blur uses the shared `haramblock-initial-blur` class.

## Telemetry

See [LOGGING.md](LOGGING.md): `video.tap.resolved`, `video.session.transition`,
`hb.video.tap.sessions`, `hb.video.coverage_ahead_sec`, `hb.video.uncovered_playing_ms`,
`hb.video.live_masking_ms`, `hb.lookahead.samples`, `hb.lookahead.failures`. The Grafana dashboard
is described in [DEBUGGING_OTEL.md](DEBUGGING_OTEL.md).

## Testing

- **Lookahead Analysis core** (`utils/lookahead/__tests__/`): recorded fixture bytes (WebM VP9 and
  fMP4 H.264 MSE captures, long- and short-GOP progressive MP4s) with fake decoder, inference and
  cache ports — exact µs Lattice Points, units cut across arbitrary appends, `timestampOffset`,
  playhead-first order, slack priorities, cache-first, live bypass, Refinement and Suspicious Clean
  probes, Keyframe Points, window refill, unreachable fetch/demux; plus the range fetch and lattice
  math.
- **Video Session reducer** (`entrypoints/content/video/session/__tests__/videoSession.test.ts`):
  hand-off hysteresis, unreachable tap, masking rule per mode, sticky status on presentation, paused
  frames, Loop Restart, initial blur, unreadable-pixel rules, viewport.
- **Timeline and presenter** (`timeline/__tests__/`, `presenter/__tests__/`): clean-cut rule,
  carry-forward bound, Live Masking hold vs lookahead cut, no suppression; extrapolated clock and
  clip paths.
- **E2E** (`tests/e2e/features/video.feature`): poster masking, the progressive and MSE taps
  (`data-hb-video-tap`), a mask visible when playback reaches the first unsafe lookahead sample, and
  Live Masking on a plain-`blob:` source. YouTube forward seeks are a manual dev-build check.

## Known limits and out of scope

- Native HLS on Chrome, `srcObject` streams and worker MSE (`MediaSourceHandle`) have no tap in v1
  and rely on Live Masking; DRM sources are handled like any unreadable source.
- The overlay pixelates masked regions by drawing the presented frame into a low-resolution canvas
  (block size from `pixelationScale`, tint from the masking filter); when the frame cannot be drawn
  it falls back to the masking `backdrop-filter`.
- When the `<video>` element itself goes fullscreen, sibling overlays are not rendered, so the
  presenter masks the whole video with the masking `filter` on the element instead of region masks —
  whole frame, not pixelated; player containers that go fullscreen keep the pixelated region
  overlay.
- The MAIN-world hook is page-visible and could be detected or fed spoofed bytes.
- Cache sharing across clients, cut-detection triggers and opportunistic lattice densification are
  future work; v1 only keys samples so sharing can come later.
