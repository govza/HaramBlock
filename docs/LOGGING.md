# Telemetry (logs, traces, metrics)

HaramBlock instruments itself with OpenTelemetry. One structured logging API replaces the old
consola logger and the WideEvent pipeline; traces describe every inference round-trip; a few metrics
summarise throughput. All of it lives in `utils/telemetry/`.

Series: part 1 (infra + migration) and part 2 (video session + DVR instrumentation, below) have
landed; part 3 adds the Grafana dashboard and collector setup.

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
`chrome-extension://*` and `moz-extension://*` origins (part 3 ships the `otel-lgtm` config). Batch
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
  stop (the machine event that stopped it).
- `video.dvr.delay_raised` - `hb.dvr.from_sec`, `hb.dvr.to_sec`, `hb.dvr.cause`
  (verdict|store_stall).
- `video.dvr.store_demoted`, `video.dvr.underrun`, `video.dvr.budget_degraded` /
  `video.dvr.budget_recovered` (ladder step, `hb.budget.*`).
- `video.audio.route` - `hb.audio.route.result` (attempt|delayLine|relay|deferred|unavailable).
- `video.capture.failed` - `hb.capture.stage`, `hb.capture.permanent`.
- `video.dvr.anomaly` + `video.dvr.tick` - the last 5 s of per-tick records (`hb.dvr.tick.*`),
  dumped under one `hb.dvr.anomaly.id` when presented fps < 0.75 x captured over 2 s, a long task >
  100 ms during playback, an analysis underrun, or a stall-driven D raise. One dump per 10 s per
  session. Thresholds live in `entrypoints/content/video/dvr/probeCore.ts`.

## Metrics

Content scripts have no meter provider: `recordGauge` / `recordHistogram`
(`utils/telemetry/metrics.ts`) forward metric records over the same RPC batch and the background
owns the instruments (`exporters/metricInstruments.ts`; gauge samples expire 5 s after their last
update). Metric names are declared once in `METRIC`. DVR metrics (per 1 s window, attrs
`hb.session.id`, `hb.dvr.store`, `hb.dvr.tap`): gauges `hb.dvr.captured_fps`,
`hb.dvr.presented_fps`, `hb.dvr.frame_repeat_ratio`, `hb.dvr.delay_sec`, `hb.dvr.ring_bytes`,
`hb.dvr.ring_span_sec`; histograms `hb.dvr.capture_ms`, `hb.dvr.present_ms`,
`hb.main_thread.long_task_ms` (while any DVR presents). `hb.inference.roundtrip_ms` (histogram,
content) and `hb.inference.queue_depth` (gauge, background) cover the inference side.

- `hb.inference.run.duration` (histogram, ms) - per task, by `hb.media.kind` / `hb.status`.
- `hb.inference.requests` (counter) - by `hb.media.kind` / `hb.status` (success|error|cached).

## Key files

- `utils/telemetry/logger.ts` - `getLogger`, sink registry, common attributes
- `utils/telemetry/propagation.ts` - `traceparent` inject/extract (api only)
- `utils/telemetry/roundtrip.ts` - content-side round-trip span bookkeeping
- `utils/telemetry/setup/background.ts` - SDK pipeline, ring, forwarded-batch ingestion
- `utils/telemetry/setup/client.ts` - forwarding setup for content/popup/options
- `utils/telemetry/exporters/` - console printer, ring, forwarding, span (de)serialisation
