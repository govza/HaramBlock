# HaramBlock

Browser extension that detects inappropriate content in page media with on-device AI and masks it,
with per-host and per-image user overrides.

This file is a thin glossary. Full definitions and architecture live in the subsystem docs indexed
by [docs/INDEX.md](docs/INDEX.md); decisions live in [docs/adr/](docs/adr/). Read the linked doc
before working in a term's area.

## Language

**Quick Toggle**: The per-image eye button that lets the user override the AI decision for one image
without changing site-wide settings. _Avoid_: eye toggle, quick switch. See
[QUICKTOGGLE.MD](docs/QUICKTOGGLE.MD)

**Forced Visibility**: The user's per-image override of the AI decision: `'auto'` (AI decides),
`'visible'` (force show), `'blocked'` (force hide). Persisted per image src. _Avoid_: toggle state,
`null` (legacy spelling of `'auto'`). See [QUICKTOGGLE.MD](docs/QUICKTOGGLE.MD)

**Mask Overlay**: The absolutely-positioned canvas inserted next to an image in its parent that
pixelates the predicted regions and tracks the image's geometry. _Avoid_: mask layer, blur overlay.
See [MEDIA_PROCESSING.md](docs/MEDIA_PROCESSING.md)

**Relay Fetch**: The background fetching a media URL on behalf of the content script (host
permissions exempt background fetch from CORS), so the content script can decode it origin-clean.
_Avoid_: proxy fetch, CORS bypass. See [VIDEO_PROCESSING.md](docs/VIDEO_PROCESSING.md)

**Video Session**: One video element playing one media source, from adoption to disposal: its
Bitstream Tap, Live Masking, Verdict Timeline and status. A same-media source change (a YouTube
quality switch) keeps it. _Avoid_: video machine, video processor. See
[VIDEO_PROCESSING.md](docs/VIDEO_PROCESSING.md)

**Media Reference**: What a site adapter or the generic rules say a playing video's media is (a
namespaced id, an MSE source known only by its page, or unidentifiable); the Identity resolver alone
turns it into the Video Identity the verdict cache keys by. _Avoid_: media id, identity hint. See
[VIDEO_PROCESSING.md](docs/VIDEO_PROCESSING.md)

**Verdict Timeline**: A Video Session's media-time-keyed history of samples — lookahead, cached and
Live Masking alike; two samples at the same time keep the unsafe one. _Avoid_: verdict track. See
[VIDEO_PROCESSING.md](docs/VIDEO_PROCESSING.md)

**Verdict Interpreter**: The single reader of a video's raw playback verdicts. Decides what covers
each presented frame, so masking and status share one reading of the verdicts. _Avoid_: verdict
filter, smoothing. See [VIDEO_PROCESSING.md](docs/VIDEO_PROCESSING.md)

**Lookahead Analysis**: Analysing a video's encoded bitstream ahead of its playhead, so verdicts
exist before the native element paints the frames they describe; the page's video and audio play
untouched (ADR 0004). _Avoid_: prefetch, DVR (the superseded re-presenting design). See
[ADR 0004](docs/adr/0004-bitstream-lookahead-replaces-continuous-dvr.md)

**Bitstream Tap**: The source of a video's encoded media for Lookahead Analysis — an MSE append
hook, a progressive-file range fetch, or a native-HLS segment fetch. _Avoid_: stream hook, demuxer
(that is one part of a tap). See
[ADR 0004](docs/adr/0004-bitstream-lookahead-replaces-continuous-dvr.md)

**Live Masking**: Page pixels sampled at the playhead whenever no Lookahead Analysis verdict covers
it — the whole session when no Bitstream Tap is reachable, otherwise only the uncovered spans (play
start, a seek past coverage, analysis falling behind). Masks apply behind the playhead, accepting a
short leak when content turns unsafe. _Avoid_: realtime mode, overlay mode, fallback mode. See
[ADR 0004](docs/adr/0004-bitstream-lookahead-replaces-continuous-dvr.md)

**Mask Presenter**: The overlay above a natively playing video that shows the masks covering its
extrapolated playhead, from the last clean sample before an unsafe span (at most 500 ms before it)
to the span's end. _Avoid_: DVR, canvas player. See [VIDEO_PROCESSING.md](docs/VIDEO_PROCESSING.md)

**Safe / Unsafe image**: An image without / with predictions. Unsafe images are masked when Forced
Visibility is `'auto'`. _Avoid_: clean image, flagged image. See
[MEDIA_PROCESSING.md](docs/MEDIA_PROCESSING.md)

### Video media

**MSE Source**: A video whose page player downloads the media itself and feeds it piece by piece
into the element (Media Source Extensions); its bytes reach Lookahead Analysis through the append
hook with no extra download. _Avoid_: blob video, stream video. See
[ADR 0004](docs/adr/0004-bitstream-lookahead-replaces-continuous-dvr.md)

**Progressive Source**: A video whose element loads one media file directly from its URL; Lookahead
Analysis reads it with its own range fetches, an extra download. _Avoid_: direct video, plain MP4.
See [ADR 0004](docs/adr/0004-bitstream-lookahead-replaces-continuous-dvr.md)

**Keyframe**: A frame that decodes on its own; every other frame is stored as a difference from
earlier frames. _Avoid_: I-frame, sync sample (container spellings). See
[VIDEO_PROCESSING.md](docs/VIDEO_PROCESSING.md)

**GOP**: A Keyframe and the frames that depend on it, up to the next Keyframe. A long-GOP source has
Keyframes 4 s or more apart. _Avoid_: group, chunk. See
[VIDEO_PROCESSING.md](docs/VIDEO_PROCESSING.md)

**GOP Prefix**: The frames from a GOP's Keyframe up to a wanted frame — what must be read and
decoded to obtain that frame. Free on an MSE Source, downloaded on a Progressive Source. _Avoid_:
decode run-up

**Analysis Unit**: One self-contained piece of an MSE Source's media (a WebM Cluster or an fMP4
fragment) that starts on a Keyframe; analysable only once fully appended. _Avoid_: segment, chunk,
append

### Lookahead sampling

Defined in full in [VIDEO_PROCESSING.md](docs/VIDEO_PROCESSING.md); the governing decision is
[ADR 0004](docs/adr/0004-bitstream-lookahead-replaces-continuous-dvr.md).

**Sample Lattice**: The fixed media times every client samples at, identical across browsers and
renditions so verdicts can be shared: level 0 every 0.5 s, each further level halving the spacing,
down to 250 ms. Levels nest, so a denser level contains every coarser point. _Avoid_: grid, sampling
interval, cadence

**Lattice Point**: One media time on the Sample Lattice; its verdict describes the frame presented
at that time. The unit the verdict cache is keyed by. _Avoid_: sample time, tick

**Keyframe Point**: A Keyframe's own media time used as a sample time on a long-GOP Progressive
Source, where Lattice Points would cost a GOP Prefix download each; the same for every client
reading the same file. _Avoid_: keyframe sample

**Refinement Probe**: A sample at the next lattice level, placed between two neighbouring samples
that disagree or beside a Suspicious Clean sample, to locate where content turns unsafe or clean.
_Avoid_: bisection sample, extra sample

**Suspicious Clean**: A clean sample whose top unsafe probability is above the suspicion threshold
but below the unsafe threshold; it triggers Refinement Probes on both sides. _Avoid_: near miss,
borderline hit

**Suspicion Threshold**: A fixed fraction of the reader's own score threshold; the lower edge of
Suspicious Clean. _Avoid_: borderline band, near-miss threshold

**Loop Wrap**: A backward jump in a looping video's media time of more than half its duration — the
playhead going from the tail back to the head. _Avoid_: loop seek

**Loop Restart**: A `seeked` that is the browser's own Loop Wrap (tail → head, both ends within 0.5
s × playback rate of the edges) rather than a user or page seek; it keeps Verdict Timeline coverage
instead of re-starting Live Masking like a seek. _Avoid_: loop wrap (for the event)
