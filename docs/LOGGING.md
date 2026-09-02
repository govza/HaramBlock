# Telemetry (logs, traces, metrics)

HaramBlock instruments itself with OpenTelemetry. One structured logging API replaces the old
consola logger and the WideEvent pipeline; traces describe every inference round-trip; a few metrics
summarise throughput. All of it lives in `utils/telemetry/`.

Series: this is part 1 of 3 (infra + migration). Part 2 adds DVR instrumentation, part 3 the Grafana
dashboard and collector setup.

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

| Context                   | Sinks                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| background                | ring (warn+ in prod, all levels in dev, 500 records); dev console (own records only); OTLP export    |
| content / popup / options | dev console; forwarded to the background (prod: warn+ logs only; dev: all logs and spans, 1 s batch) |

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

## Resource attributes

`service.name = haramblock`, `service.version`, `hb.version`, `hb.context`
(content|background|popup|options), `browser.name`, `hb.tab.id` where known. `hb.backend`
(webgpu|wasm) is stamped on every background span/log once the model has loaded.

## Trace model

One trace per **inference round-trip**:

```
inference.roundtrip (content)            hb.req.id, hb.src, hb.hostname, hb.media.kind, hb.session.id
├─ inference.capture (content)           fetch/decode of the bitmap, hb.transfer_kind
├─ inference.send (content)              the RPC call
├─ inference.cache (background)          cache lookup, hb.cache_hit
├─ inference.queue.wait (background)     enqueue → dequeue
├─ inference.run (background)            decode/preprocess/session.run, timing attrs, hb.batch_size
└─ inference.apply (content)             styling/overlay work, hb.overlay_type
```

Propagation: the inference envelopes (`IImageTransfer`, `IVideoFrameTransfer`, `IGifFrameTransfer`)
carry `traceparent` explicitly. comctx runs an async heartbeat before every RPC send, so the active
context cannot be captured in the adapter; other RPC methods therefore carry no trace context yet.
the background extracts it (`extractTraceparent`) and parents its spans under it. Results carry no
trace context back: the content side keeps the open round-trip span keyed by `src` and ends it when
the verdict is applied.

Umbrella: the content script emits one zero-length `page.session` anchor span per document at init.
Each round-trip links to it and carries `hb.session.trace_id`, so a page's traffic can be grouped
without nesting.

Video frames currently get a round-trip span that covers capture → send (part 2 extends it to the
DVR pipeline).

## Metrics

- `hb.inference.run.duration` (histogram, ms) - per task, by `hb.media.kind` / `hb.status`.
- `hb.inference.requests` (counter) - by `hb.media.kind` / `hb.status` (success|error|cached).

## Key files

- `utils/telemetry/logger.ts` - `getLogger`, sink registry, common attributes
- `utils/telemetry/propagation.ts` - `traceparent` inject/extract (api only)
- `utils/telemetry/roundtrip.ts` - content-side round-trip span bookkeeping
- `utils/telemetry/setup/background.ts` - SDK pipeline, ring, forwarded-batch ingestion
- `utils/telemetry/setup/client.ts` - forwarding setup for content/popup/options
- `utils/telemetry/exporters/` - console printer, ring, forwarding, span (de)serialisation
