# Telemetry (logs, traces, metrics)

HaramBlock instruments itself with OpenTelemetry. One structured logging API replaces the old
consola logger and the WideEvent pipeline; traces describe every inference round-trip; a few metrics
summarise throughput. All of it lives in `utils/telemetry/`.

The local collector + Grafana stack and the DVR dashboard are documented in
[DEBUGGING_OTEL.md](DEBUGGING_OTEL.md).

## Logging API

```ts
import { getLogger } from '@/utils/telemetry';

const log = getLogger('ImageProcessor'); // scope = instrumentation scope name

log.debug('inference.retry', { src, attempt });
log.warn('capture.bitmap.failed', { src, fallback: 'url', error });
```

- Levels: `debug`, `info`, `warn`, `error`.
- The message is a **static dotted event name**. Never interpolate values into it; put them in the
  attributes object. `error` values expand to `error.type` / `error.message` / `error.stack`, plain
  objects are JSON-stringified.
- An optional third argument is a trace `Context`; the record then carries that span's trace and
  span ids. Never rely on `context.active()` across an `await` - pass the context explicitly.

## Where records go

| Context                   | Sinks                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| background                | ring (warn+ in prod, all levels in dev, 500 records); dev console (own records only); OTLP export                                                           |
| content / popup / options | dev console; forwarded to the background (warn+ logs only unless OTLP export is enabled, then all logs and spans; 1 s batch, 5 s retry, 1000-record buffer) |

Forwarding uses `backgroundRpc.pushTelemetry(batch)`; the background re-emits forwarded logs and
spans into its own processors, so the collector sees one `service.name = haramblock` with an
`hb.context` resource attribute per origin. The background is the **only** context that talks to the
collector: content-script `fetch` is blocked by page CSP.

"Copy logs" in the popup exports the background ring as JSON (`getTelemetryExport`).

## Enabling the OTLP export

Telemetry export is compiled in only for development builds (`pnpm dev`, `pnpm dev:firefox`, or a
static `wxt build --mode development` for either browser) and only when an endpoint is configured:

```
WXT_OTEL_ENDPOINT=http://localhost:4318   # default; set to '' to disable
```

The flag is a build-time define (`__HB_TELEMETRY_ENABLED__`), so production bundles keep only
`@opentelemetry/api` (no-op tracer / meter) and the ring.

Exporters (`@opentelemetry/exporter-*-otlp-http`) post cross-origin; the collector must allow
`chrome-extension://*` and `moz-extension://*` origins (`tools/otel/otelcol-config.yaml`). Batch
processors flush every 1 s, metrics export every 1 s, and a 5 s idle timer force-flushes everything
(Firefox event pages have no `runtime.onSuspend`).

## Attribute naming

`hb.*` keys follow the OTel semantic-convention shape: dot-separated namespaces, `snake_case` only
inside a segment (`hb.media.kind`, `hb.session.trace_id`, `hb.timing.queue_ms`). Every key is
declared once in `ATTR` (`utils/telemetry/attributes.ts`); call sites never spell `hb.*` strings.

## Resource attributes

`service.name = haramblock`, `service.version`, `hb.version`, `hb.context`
(content|background|popup|options), `browser.name`, `hb.tab.id` where known. `hb.backend`
(webgpu|wasm) is stamped on every background span/log once the model has loaded.

## Trace model

One trace per **inference round-trip**:

```
inference.roundtrip (content)            hb.request.id, hb.media.src, hb.hostname, hb.media.kind, hb.session.id
├─ inference.capture (content)           fetch/decode of the bitmap, hb.transfer.kind
├─ inference.send (content)              the RPC call
├─ inference.cache (background)          cache lookup, hb.cache.hit
├─ inference.queue.wait (background)     enqueue → dequeue
├─ inference.run (background)            decode/preprocess/session.run, timing attrs, hb.batch.size
└─ inference.apply (content)             styling/overlay work, hb.overlay.type
```

Propagation: the inference envelopes (`IImageTransfer`, `IVideoFrameTransfer`, `IGifFrameTransfer`)
carry `traceparent` explicitly; the background extracts it (`extractTraceparent`) and parents its
spans under it. Every result (`ImageInferenceResult`, `FrameInferenceResult`,
`GifFrameInferenceResult`) echoes the same `traceparent` back. The content side keeps open
round-trip spans keyed by `src` and, before ending one, checks the reply's trace id against it
(`roundtripMatches`) so a late reply for a superseded request cannot close the newer span. comctx
runs an async heartbeat before every RPC send, so the active context cannot be captured in the
adapter; other RPC methods therefore carry no trace context yet.

Umbrella: the content script emits one zero-length `page.session` anchor span per document at init.
Each round-trip links to it and carries `hb.session.trace_id`, so a page's traffic can be grouped
without nesting.

Video frames get a round-trip span with a single `inference.send` child, plus
`hb.media.timestamp_sec`. Every VideoSession also opens a `video.session` umbrella trace: its
round-trips link to it (same `hb.session.trace_id` + span link shape as `page.session`) and each DVR
start opens a `video.dvr.warmup` span under it that ends at `bufferReady` (`hb.status` =
ready|aborted).

## Video session + DVR events

All carry `hb.session.id`; DVR events add `hb.dvr.store` (raw|encoded) and `hb.dvr.tap` (tap|rvfc).

- `video.session.transition` - every phase / DVR sub-state / audio-route change (`hb.session.from`,
  `hb.session.to`, `hb.session.event`, `hb.session.dvr`, `hb.session.audio_route`).
- `video.dvr.start` / `video.dvr.stop` - `hb.dvr.delay_sec`, `hb.dvr.covered`, `hb.dvr.reason` on
  stop (the machine event that stopped it). Start also carries `hb.dvr.tap_reason` (tap, or why the
  push tap is unavailable: no_track_processor | no_capture_stream | capture_stream_failed |
  no_video_track | processor_failed - Firefox always reports `no_track_processor`) and the source
  geometry `hb.media.native_width` / `hb.media.native_height` / `hb.media.display_width`. Every
  lifecycle record carries `hb.dvr.store_reason` (encoded | probing | disabled | ineligible |
  session_cap | webcodecs_unsupported | released_before_probe | codec_error): why the store is on
  its current backing, read at stop for the final answer.
- `video.dvr.delay_raised` - `hb.dvr.from_sec`, `hb.dvr.to_sec`, `hb.dvr.cause`
  (verdict|store_stall).
- `video.dvr.tap_changed` - `hb.dvr.from`, `hb.dvr.to` (tap|rvfc): the effective capture path
  switched mid-run (a tap went silent and rVFC took over, or the tap came back). `hb.dvr.tap` on
  every DVR record reflects the effective path, not just whether a tap driver exists.
- `video.dvr.store_demoted`, `video.dvr.underrun`, `video.dvr.budget_degraded` /
  `video.dvr.budget_recovered` (ladder step, `hb.budget.*`).
- `video.dvr.ring_flushed` - the frame store emptied itself mid-run: `hb.dvr.cause` (backstep: the
  capture key went backwards past `STALE_FRAME_TOLERANCE_SEC` (0.5 s, a loop restart or a seek
  without a `seeked` event); store: codec reconfiguration; swap: raw <-> encoded exchange),
  `hb.dvr.from_sec` / `hb.dvr.to_sec` (previous and offending capture key) and
  `hb.dvr.span_lost_sec` (buffered media the flush discarded). Every flush costs a pinned refill of
  `D` seconds, so this is the first thing to check behind a freeze.
- `video.audio.route` - `hb.audio.route.result` (attempt|delayLine|relay|deferred|unavailable).
- `video.capture.failed` - `hb.capture.stage`, `hb.capture.permanent`.
- `video.dvr.anomaly` + `video.dvr.tick` - the last 5 s of per-tick records (`hb.dvr.tick.*`),
  dumped under one `hb.dvr.anomaly.id` when presented fps < 0.75 x captured over 2 s, a long task >
  100 ms during playback, an analysis underrun, or a stall-driven D raise. One dump per 10 s per
  session. Thresholds live in `entrypoints/content/video/dvr/probeCore.ts`. Each tick also records
  `hb.dvr.tick.wall_gap_ms` (wall time since the previous frame delivery) and
  `hb.dvr.tick.media_delta` (mediaTime advance of that delivery): a delta of two frame intervals is
  a source frame the browser never delivered, a negative delta is a backstep (see
  `hb.dvr.source_backsteps`), a wall gap well above the frame interval is a late callback. The
  presenter side carries `hb.dvr.tick.outcome` (new | repeat | miss - a miss is a target the store
  could not serve, invisible in the old boolean), `hb.dvr.tick.pinned` (held on the earliest frame
  because the ring does not yet span `D`) and `hb.dvr.tick.ring_span_sec`.

## Metrics

Content scripts have no meter provider: `recordGauge` / `recordHistogram` / `recordCounter`
(`utils/telemetry/metrics.ts`) forward metric records over the same RPC batch and the background
owns the instruments (`exporters/metricInstruments.ts`; gauge samples expire 5 s after their last
update, counters are monotonic and add each forwarded value). Metric names are declared once in
`METRIC`. All DVR-side metrics are emitted by the DVR probe
(`entrypoints/content/video/dvr/probe.ts`) per 1 s window; the run, presenter and audio modules feed
it through ports and never call the metric API themselves.

All DVR metrics carry `hb.browser` (chrome|firefox) so the two capture pipelines (encoded/tap vs
raw/rVFC) can be compared in one query.

**Per-session gauges** (attrs `hb.session.id`, `hb.dvr.store`, `hb.dvr.tap`): `hb.dvr.captured_fps`,
`hb.dvr.source_fps` (distinct mediaTime deliveries per window - the rate the browser actually handed
frames to us, before the capture throttle), `hb.dvr.ticks_deduped` (deliveries that repeated the
previous mediaTime; observed ~0 on both browsers - Firefox's rVFC also fires only for new frames),
`hb.dvr.capture_width` / `hb.dvr.capture_height` (the ring capture size actually applied - budget
ladder tier or native on the encoded store) next to `hb.dvr.native_width` / `hb.dvr.native_height`
(the element's `videoWidth` / `videoHeight` at the window flush; capture above native is an
upscale), `hb.dvr.main_thread_ms` (capture + present time the DVR spent on the main thread inside
the 1 s window - the DVR's own share of the frame budget), `hb.dvr.presented_fps`,
`hb.dvr.frame_repeat_ratio`, `hb.dvr.delay_sec`, `hb.dvr.ring_bytes`, `hb.dvr.ring_span_sec`,
`hb.dvr.playback_active` (1 while the presenter advances, 0 while paused / ended / warming - every
window, so 0 fps is never ambiguous), `hb.dvr.verdict_margin_sec` (D minus the observed round-trip
p90; only while active) and `hb.audio.drift_ms` (+ `hb.audio.route`; relay: audio element vs
`currentTime - D`, delay line: DelayNode ramp vs wanted D). Histograms `hb.dvr.capture_ms` (split
into `hb.dvr.capture_draw_ms` + `hb.dvr.capture_transfer_ms` on the raw store: drawImage vs
transferToImageBitmap; both 0 on the encoded store), `hb.dvr.present_ms`, `hb.dvr.tick_gap_ms` (wall
gap between consecutive new-frame deliveries), `hb.main_thread.long_task_ms` (while any DVR
presents) and `hb.main_thread.loop_lag_ms` (drift of a 250 ms `setTimeout` sampled while any DVR
presents and the tab is visible; one timer shared by all sessions). Firefox has no `longtask`
observer, so there the loop lag stands in for it: a lag > 100 ms counts as the window's longest task
for the health definition and trips the `long_task` anomaly.

**Rollup counters** (attrs `hb.dvr.store`, `hb.dvr.tap` - never `hb.session.id`, so fleet panels
stay readable at 25+ sessions). Emitted only for active windows unless noted:

- `hb.dvr.active_windows`, `hb.dvr.healthy_windows` - the health definition below.
- `hb.dvr.freeze_windows` - active window with no new frame presented.
- `hb.dvr.frames_dropped` - `captured - presented_new - presented_repeat`, clamped at 0.
- `hb.dvr.source_frames_skipped` - mediaTime advanced by more than 1.5 frame intervals between two
  deliveries: the source produced frames the browser never handed to rVFC / the tap. Frame interval
  = smallest positive mediaTime delta seen since the last seek.
- `hb.dvr.ticks_late` - a new-frame delivery arrived more than 1.5 frame intervals of wall time
  after the previous one (callback held back by main-thread work).
- `hb.dvr.source_backsteps{hb.dvr.backstep_frames}` - deliveries whose mediaTime went backwards, by
  size in frame intervals (`1` | `2` | `3+` | `seek`; seek = more than `BACKSTEP_SEEK_FRAMES` or no
  interval learnt yet). One- and two-frame backsteps are the browser re-delivering an older frame
  (Firefox rVFC does this every 15-40 s) and are absorbed by the store's `STALE_FRAME_TOLERANCE_SEC`
  (0.5 s absolute; the `3+` bucket's upper bound at 24 fps, so the two only coincide at that rate) -
  they count here but do not flush. A backstep beyond the tolerance, or more than
  `MAX_CONSECUTIVE_STALE_FRAMES` sub-tolerance backsteps in a row (a natively looping clip shorter
  than the tolerance), becomes a `video.dvr.ring_flushed`.
- `hb.dvr.pinned_windows` - active windows in which the presenter held the earliest buffered frame
  because the ring did not yet span `D` (warm-up, seek re-warm, or a flush refilling). A frozen
  window that is also pinned is a ring refill; a frozen window that is not is a decode / present
  problem.
- `hb.dvr.ring_flushes{hb.dvr.cause}` - one per `video.dvr.ring_flushed`.
- `hb.audio.route_windows`, `hb.audio.underruns`, `hb.audio.unavailable_windows` - all with
  `hb.audio.route` (none|pending|delayLine|relay|deferred|unavailable). Underruns are delay-line
  AudioContext interruptions plus relay `waiting` events and hard resync seeks.
- `hb.dvr.anomalies{hb.dvr.cause}` - one per `video.dvr.anomaly` dump.
- `hb.dvr.runs_started`, `hb.dvr.runs_stopped{hb.dvr.reason}` - alongside `video.dvr.start` /
  `video.dvr.stop`.

**Warmup**: `hb.dvr.warmup_ms` (histogram, `hb.status` ready|aborted) where the `video.dvr.warmup`
span ends.

**Sampler** (`entrypoints/content/communication/sender.ts`, attrs `hb.transfer.kind`):
`hb.sampler.encode_ms` (histogram, + `hb.session.id`) - `bitmapToCompressedBlob` WebP encode on the
content main thread for the Firefox blob transport; `hb.sampler.frames_sent` (counter) - inference
frames handed to the background per transfer kind.

**Health definition** (one place: `HEALTHY_*` in `entrypoints/content/video/dvr/probeCore.ts`,
quoted by the dashboard queries): a 1 s window is healthy when `playback_active == 1`,
`presented_new + presented_repeat >= 0.9 x captured`, no long task > 100 ms, no freeze and no audio
underrun. Health % = healthy windows / active windows; with zero active windows the tiles read "no
data", never "healthy".

Inference side: `hb.inference.roundtrip_ms` (histogram, content) and `hb.inference.queue_depth`
(gauge, background).

- `hb.inference.run.duration` (histogram, ms) - per task, by `hb.media.kind` / `hb.status`.
- `hb.inference.requests` (counter) - by `hb.media.kind` / `hb.status` (success|error|cached).

## Key files

- `utils/telemetry/logger.ts` - `getLogger`, sink registry, common attributes
- `utils/telemetry/propagation.ts` - `traceparent` inject/extract (api only)
- `utils/telemetry/roundtrip.ts` - content-side round-trip span bookkeeping
- `utils/telemetry/setup/background.ts` - SDK pipeline, ring, forwarded-batch ingestion
- `utils/telemetry/setup/client.ts` - forwarding setup for content/popup/options
- `utils/telemetry/exporters/` - console printer, ring, forwarding, span (de)serialisation
