# Continuous DVR for all processed videos; audio delayability gates protection

Status: accepted (2026-08-09)

Masked playback used to be a mode entered on an unsafe verdict, and every mode crossing produced a
visible/audible switch (audio gap on engage, forward jump on release and pause). We decided to run
the DVR's delayed presentation for **every** playing video under a process policy, from play onward,
so no crossing ever happens; and to make audio delayability a **precondition** for processing a
video at all - a video whose audio can never be routed through the delay line (origin-tainted
source, or element already captured by the site) is finalized `skipped` with no masking and no
inference, because permanently desynced audio was judged a worse everyday experience than absent
protection on those sites.

## Considered Options

- **Variable latched delay, one presenter** (previously accepted, now superseded): D derived from
  verdict coverage, eager DVR engagement on low coverage, native presentation at D=0 later. Rejected
  on reconsideration: still carries engage/demote boundaries, and its benefits depend on a verdict
  cache that does not exist yet.
- **DVR only while masked** (original design): every engage/release is a visible switch.
- **DVR with live audio when undelayable**: masked but permanently lip-sync-desynced; rejected.
- **DOM-overlay masking when undelayable**: masks chase moving content; rejected with it.

## Consequences

Every processed video pays ~D of pinned start, is watched D behind the live edge (including live
streams), and costs capture/canvas CPU plus ring memory while playing - bounded by a global budget
auto-tiered by inference backend (WebGPU high, WASM low) with graceful per-session degradation.
Sites where audio cannot be delayed receive **no protection**; this is a deliberate protection
downgrade, chosen knowingly.
