# Debugging with OpenTelemetry (local Grafana stack)

How to run the local collector + Grafana, point a dev build at it, and read the DVR dashboard. The
instrumentation itself (logging API, trace model, metric names) is documented in
[LOGGING.md](LOGGING.md); this page is the operational side. Everything here applies to
**development builds only** - production bundles compile the exporters out and keep only the ring
(see "Production: the ring export" below).

## Setup

Prerequisites: Docker with `docker compose` (or the standalone `docker-compose`).

```
pnpm otel:up      # build + start grafana/otel-lgtm, wait for the collector
pnpm otel:down    # stop it (the data volume survives)
```

`pnpm dev`, `pnpm dev:no-gpu` and `pnpm dev:firefox` run the same script as a pre-step, so the stack
comes up on its own before the build. There it never blocks: without Docker it prints a warning and
the dev build's exports fail quietly. Skip the pre-step with `SKIP_OTEL_STACK=1`.

What runs (`tools/otel/`):

| Piece                     | Where                                                           |
| ------------------------- | --------------------------------------------------------------- |
| Grafana (anonymous admin) | http://localhost:3001                                           |
| OTLP/HTTP receiver        | http://localhost:4318 (`/v1/traces`, `/v1/metrics`, `/v1/logs`) |
| OTLP/gRPC receiver        | localhost:4317                                                  |
| DVR dashboard             | http://localhost:3001/d/haramblock-dvr                          |

Grafana is on **3001**, not the image default 3000, because WXT's dev server owns 3000
(`scripts/assert-dev-port-free.mjs`).

`docker-compose.yml` builds a one-layer image on top of `grafana/otel-lgtm` (`Dockerfile`) that
copies in:

- `otelcol-config.yaml` - the upstream collector config plus CORS for extension origins
  (`chrome-extension://*`, `moz-extension://*`, `http://*`, `https://*`, any request header). The
  background service worker posts OTLP cross-origin, so the preflight has to succeed or every export
  fails silently.
- `grafana-dashboards.yaml` + `dashboards/haramblock-dvr.json` - the provisioned dashboard. UI edits
  are allowed but lost on the next `otel:up`; edit the JSON instead.

A `COPY` instead of a bind mount is deliberate: the stack then works against remote or WSL Docker
daemons where Windows host paths cannot be mounted. Rebuilds are automatic (`up --build`).

## Configuring the build

```
# .env (see .env.example)
WXT_OTEL_ENDPOINT=http://localhost:4318   # default when unset; '' disables export
```

`wxt.config.ts` reads it through Vite's `loadEnv` and bakes it into the `__HB_OTEL_ENDPOINT__`
define; `__HB_TELEMETRY_ENABLED__` is true only for `--mode development` builds with a non-empty
endpoint. Changing `.env` therefore needs a rebuild / dev-server restart.

### Chrome

```
pnpm dev
```

The background context is the only one that talks to the collector (content scripts are blocked by
page CSP); content / popup / options forward their records over `pushTelemetry`. Open a page with a
video, let it play, then reload the dashboard. If nothing arrives:

1. Service-worker console (`chrome://extensions` → service worker): look for failed
   `POST http://localhost:4318/v1/...`. A CORS error means the collector is not running the
   HaramBlock config (`pnpm otel:down && pnpm otel:up`).
2. Stale service worker: `Frame prediction arrived without timestampSec` in the console means the
   worker runs an old build - reload the extension (see
   [BROWSER_DEBUGGING.md](BROWSER_DEBUGGING.md)).
3. Check the collector saw anything: `docker logs haramblock-otel-lgtm`.

### Firefox

Firefox uses an event-page background (no service worker) and the same OTLP/HTTP exporters. Either:

```
pnpm dev:firefox
```

or a static development build driven by `web-ext`:

```
pnpm exec wxt build -b firefox --mode development
pnpm exec web-ext run -s .output/firefox-mv3
```

The `--mode development` flag is what compiles the exporters in; a plain `pnpm build:firefox`
produces a production bundle with no export. Firefox has no `runtime.onSuspend`, so the background
force-flushes on a 5 s idle timer - the last records of a session show up a few seconds late.

## Reading the DVR dashboard

Dashboard variable **VideoSession** (`hb_session_id`) filters every DVR panel; "All" overlays
sessions. Time range defaults to the last 15 minutes with 5 s refresh.

**DVR (per VideoSession)**

- _Captured vs presented fps_ - the DVR's two 1 s-window rates. Presented tracking captured means
  the delay line keeps up. Presented < 0.75 x captured for 2 consecutive windows is the fps anomaly
  trigger.
- _Frame repeat ratio_ - share of presented ticks that re-served the previous frame. Rises when the
  store is behind (see `video.dvr.underrun` / `store_stall`).
- _D (delay) over time_ - the DVR delay in seconds. Steps coincide with `video.dvr.delay_raised`
  annotations (orange), cause `verdict` or `store_stall`.
- _Ring bytes / span_ - frame store size in bytes and how many seconds of media it covers (right
  axis). Watch it against `video.dvr.budget_degraded` events.
- _Capture time_ / _Present time_ - heatmaps of the per-tick histograms (`hb.dvr.capture_ms`,
  `hb.dvr.present_ms`). Bands drifting upwards point at main-thread pressure.
- _Main-thread long tasks_ - count of `longtask` entries per interval and their p90 duration. Any
  task > 100 ms during playback triggers an anomaly dump.
- _DVR anomaly dumps_ - Loki: `video.dvr.anomaly` headers and their `video.dvr.tick` rows (last 5 s
  of per-tick records, one dump per 10 s per session, grouped by `hb_dvr_anomaly_id`). Expand a row
  for the `hb_dvr_tick_*` fields; the `trace_id` field links into Tempo.
- _Session + DVR events_ - every other `video.*` event: `video.session.transition` (phase, DVR
  sub-state, audio route), `video.dvr.start` / `stop` / `store_demoted` / `underrun` /
  `budget_degraded` / `budget_recovered`, `video.audio.route`, `video.capture.failed`.

Red annotations across all panels mark `video.dvr.anomaly` events.

**Inference**

- _Inference round-trip (content)_ - p50 / p90 of `hb.inference.roundtrip_ms` (video frames, as
  measured by the frame sampler).
- _Inference run (background)_ - p50 / p90 of `hb.inference.run.duration` by media kind.
- _Inference requests / s_ by media kind and status (`success` | `error` | `cached`).
- _Inference queue depth_ - background queue size + in-flight.

**Traces** (Tempo, TraceQL tables)

- _video.session umbrella traces_ - one per VideoSession; `video.dvr.warmup` spans hang under it,
  round-trips carry its id in `hb.session.trace_id`.
- _Slow inference round-trips_ - `inference.roundtrip` traces over 500 ms. Open one to see `capture`
  → `send` → `cache` → `queue.wait` → `run` → `apply`.

From any trace, "Logs for this span" queries Loki by `trace_id`; from any log line the `trace_id`
field opens the trace.

## Vocabulary in the stores

The extension emits OTel names; the stores rename them.

| In code (`ATTR` / `METRIC`)             | Prometheus                                     | Loki                                |
| --------------------------------------- | ---------------------------------------------- | ----------------------------------- |
| `hb.dvr.captured_fps` (gauge)           | `hb_dvr_captured_fps`                          | -                                   |
| `hb.dvr.capture_ms` (histogram)         | `hb_dvr_capture_ms_bucket` / `_sum` / `_count` | -                                   |
| `hb.inference.run.duration` (unit `ms`) | `hb_inference_run_duration_milliseconds_*`     | -                                   |
| `hb.inference.requests` (counter)       | `hb_inference_requests_total`                  | -                                   |
| attribute `hb.session.id`               | label `hb_session_id`                          | structured metadata `hb_session_id` |
| resource `service.name`                 | `service_name` (also `job`)                    | stream label `service_name`         |
| event name (log body)                   | -                                              | the line; filter with `             | =`/` | ~`  |
| `hb.context`, `browser.name`            | `target_info` only                             | `hb_context`, `browser_name`        |

Prometheus appends the unit only when the instrument declares one, which is why the DVR histograms
keep their `_ms` name and the background duration gains `_milliseconds`. Dots become underscores
everywhere. The dashboard's queries are checked against `ATTR` and `METRIC` by
`utils/telemetry/__tests__/dvrDashboard.test.ts`, so renaming a metric or attribute fails the unit
suite until the JSON follows.

Event names and their attributes are listed in [LOGGING.md](LOGGING.md) ("Video session + DVR
events", "Metrics").

## Production: the ring export

Release builds carry no exporters. The background keeps a 500-record ring of `warn`+ logs (all
levels in dev); the popup's `[logs]` button (`CopyLogsButton`) calls `getTelemetryExport` and puts
the ring on the clipboard as JSON:

```json
{ "exportedAt": 1757000000000, "version": "3.5.8", "userAgent": "...", "recordCount": 12, "records": [ ... ] }
```

Each record is a `TelemetryLogRecord` with the same event name and `hb.*` attributes the collector
would have received, plus `traceId` / `spanId` when the log was emitted under a span. To read a
user-supplied export, paste the records into any JSON viewer and filter on the event name; to replay
one visually, Grafana Explore → Loki accepts no direct import, so compare against a local session on
the same event vocabulary instead.
