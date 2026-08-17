# Direct-URL Relay Audio; the machine owns the audio route

Status: accepted (2026-08-17)

A `/code-review` of the Relay Fetch / Relay Audio branch confirmed 8 bugs that reduce to structural
flaws: the Relay Fetch blob lived in `corsVideoCache` (a discard-anytime capture cache) while Relay
Audio's continuity depended on it; the "audible audio must have a delayed route" policy was enforced
in three racing call sites with different predicates and a terminal `audioUndelayable` outcome; blob
availability was pull-based ("not yet" indistinguishable from "never"); and the whole-file download
had no timeout or abort and a byte cap borrowed from the DVR ring budget. We decided to restructure
instead of point-fixing the policy, and to point-fix the capture path.

## Decision

- **Direct-URL Relay Audio.** The hidden audio element plays the video's resolved **original URL**
  at `currentTime − D` — media playback needs no CORS; only pixel/sample readback does. No blob, no
  download, no cap, no fetch wait for audio, and no coupling to any cache's lifetime. Engage latency
  is element buffering. The page element is silenced via `volume = 0` (not `muted`: a site mute
  writing `muted = true` onto an already-forced-true flag changes nothing and fires no
  `volumechange`, blinding the site's mute button); the mirror guard is an async-safe pending-writes
  counter, replacing the synchronous flag that misread the module's own async-delivered writes as
  site intent. The element reports `engaged` only once playable; unsupported/undecodable sources are
  terminal per src, buffering timeouts and other media errors transient. On the DVR drain the
  element free-runs the `D`-second tail on the wall clock before pausing.
- **The session machine owns the audio route.** `VideoSessionState` gains
  `audioRoute: none | pending | delayLine | relay` and `audible` (site intent). The adapter reports
  one `audioEngageResult` (`delayLine | relay | deferred | unavailable`) per `engageAudioRoute`
  effect; raw `unmuted`/`muted` intent events replace the registry's withdrawal predicate;
  `audioUndelayable` is removed. Reducer policy: engage attempts fire on `bufferReady`, resume, and
  every verdict while `pending`; `pending` + audible holds the page mute (bounded silence, also
  covering the deferred-`AudioContext` pre-gesture window); withdrawal (finalize `skipped`) only
  when audible AND the delay line is permanently unavailable AND the relay element terminally
  failed; muted sessions never withdraw and retry on unmute; DVR stop/pause/seek re-warm release the
  route to `none` and re-engage on resume; the `ended` drain keeps it.
- **Tier-3 capture point fixes** (capture stays lazy; no session-owned RelayMedia resource): a
  dedicated `MEDIA_DOWNLOAD_MAX_BYTES` (64 MB) cap replaces the imported DVR ring-budget tiers; the
  background fetch gets an abort-based whole-download timeout; concurrent CORS-safe-source callers
  (sampler + mask overlay) share one in-flight clone/download per video. Base64 transport is kept
  (bounded by the smaller cap); transferable transport is parked.

## Considered Options

- **RelayMedia as a session-owned resource** (eager per-session download with its own
  idle→fetching→ready machine): obsolete once audio is blob-free — the only consumer that needed
  ownership guarantees no longer consumes bytes.
- **Reusing the Tier-3 blob for audio when present**: rejected; it would re-couple audio to a
  discard-anytime cache, the root ownership inversion.
- **`chrome.offscreen` audio playback**: breaks tab mute/speaker indicators, adds cross-context
  sync, and has no Firefox path — direct-URL playback in the page dominates it.
- **Point-fix the findings in place**: rejected for the policy (every fix would re-encode the same
  scattered enforcement); accepted for the capture path, where the fixes are local.

## Consequences

An audible video whose route is still pending plays silent for a bounded window (element buffering
or the pre-gesture wait) instead of desynced or permanently unprotected. Relay Audio issues a second
media request for the file from the page context (same cookies/Referer as the page's own request;
expiring signed URLs fall into the transient-retry path). Muted autoplay grids cost zero extra
downloads for audio. The machine grows an `audioRoute` axis whose policy matrix is enumerable in
pure reducer tests; the three former enforcement sites (adapter engage fallback, registry
`volumechange` predicate, `syncAudioDelay` re-engage) collapse into reducer transitions plus one
adapter executor. The service worker never buffers more than the dedicated cap and cannot hang
samplers past the fetch timeout.
