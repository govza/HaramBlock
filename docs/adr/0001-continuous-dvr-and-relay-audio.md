# Continuous DVR for all processed videos; Relay Audio when the delay line cannot serve

Status: accepted (2026-08-09, audio routing revised 2026-08-15)

Masked playback used to be a mode entered on an unsafe verdict, and every mode crossing produced a
visible/audible switch (audio gap on engage, forward jump on release and pause). We decided to run
the DVR's delayed presentation for **every** playing video under a process policy, from play onward,
so no crossing ever happens.

Audio follows the delayed timeline through whichever route is available:

- **WebAudio delay line** when the source is untainted.
- **Relay Audio** when it is not: a hidden `<audio>` element plays the video's original URL at
  `currentTime - D` (delay by time offset, no DelayNode; media playback needs no CORS — revised from
  blob-fed to direct-URL in ADR 0002), with the page element silenced while engaged and the site's
  muted/volume intent mirrored and restored.
- **Protection withdraws only when audible audio truly has no route**: delay line unavailable, Relay
  Audio impossible (relay element terminally cannot play), and the video audibly unmuted - decided
  by the session machine's audio-route policy (ADR 0002), not at adoption. Permanently desynced
  audio was judged a worse everyday experience than absent protection; a muted video has no audio to
  desync and stays protected.

## Considered Options

- **Variable latched delay, one presenter**: D derived from verdict coverage, eager DVR engagement
  on low coverage, native presentation at D=0 later. Rejected: still carries engage/demote
  boundaries, and its benefits depend on a verdict cache that does not exist yet.
- **DVR only while masked** (original design): every engage/release is a visible switch.
- **DVR with live audio when undelayable**: masked but permanently lip-sync-desynced; rejected.
- **DOM-overlay masking when undelayable**: masks chase moving content; rejected with it.
- **Audio delayability as an adoption gate**: any video whose audio could not ride the delay line
  finalized `skipped` - no inference, no masking. Rejected: it excluded exactly the sites the
  pipeline most needed to cover (cross-origin non-CORS CDNs), which Relay Fetch now makes servable.
- **DelayNode over relay-decoded samples**: route decoded blob audio through WebAudio; more moving
  parts (decode graph, gesture-gated context) for the same audible result as a time-offset element.

## Consequences

Every processed video pays ~D of pinned start, is watched D behind the live edge (including live
streams), and costs capture/canvas CPU plus ring memory while playing - bounded by a global budget
auto-tiered by inference backend (WebGPU high, WASM low) with graceful per-session degradation.
Non-CORS cross-origin videos carry a hidden audio element plus ~500 ms drift-sync ticks while
engaged (the Tier-3 capture download, when it happens, is bounded by its own dedicated cap — ADR
0002); sites that fight the forced page-element silencing may audibly double audio briefly until the
mirror re-silences. A video unmuted while its route is pending rides a bounded silence, and
protection withdraws only when no route is obtainable at all (ADR 0002) - a deliberate protection
downgrade, chosen knowingly.
