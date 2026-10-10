# Debugging with OpenTelemetry (local Grafana stack)

How to run the local collector + Grafana, point a dev build at it, and read the video dashboard. The
instrumentation itself (logging API, trace model, metric names) is documented in
[LOGGING.md](LOGGING.md); this page is the operational side. Everything here applies to
**development builds only** - production bundles compile the exporters out and keep only the ring
(see "Production: the ring export" below).

## Setup

Prerequisites: Docker with `docker compose` (or the standalone `docker-compose`).

```
pnpm otel:up      # build + start grafana/otel-lgtm, wait for the collector
pnpm otel:down    # stop it (the data volume survives)
pnpm otel:clear   # drop the data volume and restart empty
```

The stores are never emptied on their own, so data from earlier runs stays queryable across days.
That is harmless for time-bounded queries and the per-session panels, but the rollup tiles read
every session in the dashboard range; run `pnpm otel:clear` before a repro when a clean slate
matters, or just narrow the time range.

`pnpm dev`, `pnpm dev:no-gpu` and `pnpm dev:firefox` run the same script as a pre-step, so the stack
comes up on its own before the build. There it never blocks: without Docker it prints a warning and
the dev build's exports fail quietly. Skip the pre-step with `SKIP_OTEL_STACK=1`.

What runs (`tools/otel/`):

| Piece                     | Where                                                           |
| ------------------------- | --------------------------------------------------------------- |
| Grafana (anonymous admin) | http://localhost:3001                                           |
| OTLP/HTTP receiver        | http://localhost:4318 (`/v1/traces`, `/v1/metrics`, `/v1/logs`) |
| OTLP/gRPC receiver        | localhost:4317                                                  |
| Video dashboard           | http://localhost:3001/d/haramblock-video                        |

Grafana is on **3001**, not the image default 3000, because WXT's dev server owns 3000
(`scripts/assert-dev-port-free.mjs`).

`docker-compose.yml` builds a one-layer image on top of `grafana/otel-lgtm` (`Dockerfile`) that
copies in:

- `otelcol-config.yaml` - the upstream collector config plus CORS for extension origins
  (`chrome-extension://*`, `moz-extension://*`, `http://*`, `https://*`, any request header). The
  background service worker posts OTLP cross-origin, so the preflight has to succeed or every export
  fails silently.
- `grafana-dashboards.yaml` + `dashboards/haramblock-video.json` - the provisioned dashboard. UI
  edits are allowed but lost on the next `otel:up`; edit the JSON instead.

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

## Reading the video dashboard

Dashboard variable **VideoSession** (`hb_session_id`) filters every Loki panel (as a
structured-metadata filter after the line filters); "All" overlays sessions. The coverage tiles and
rollup panels aggregate every session on purpose, never by session id. Time range defaults to the
last 15 minutes with 5 s refresh. Orange annotations mark `video.tap.resolved` events whose tap is
`none`.

**Coverage** (stat row, all sessions, over the dashboard range; every tile reads "no data" while
nothing plays)

- _Tap reachable %_ - sessions whose Bitstream Tap was mse or progressive / all sessions
  (`hb.video.tap.sessions`).
- _Uncovered while playing (s/min)_ - playing time with no verdict covering the playhead, per minute
  of range (`hb.video.uncovered_playing_ms`). The coverage-regression tile.
- _Live Masking p90 per session_ - `hb.video.live_masking_ms`.
- _Lookahead cache hit %_ - cache-answered / all lookahead samples (`hb.lookahead.samples`).
- _Coverage ahead p50_ - `hb.video.coverage_ahead_sec` while playing; red under the 1.5 s Live
  Masking start, green from the 5 s stop.
- _Lookahead failures_ - Analysis Unit demux/decode failures (`hb.lookahead.failures`).

**Lookahead**

- _Lookahead samples / s_ - analysed vs cache by `hb_lookahead_sample_source`.
- _Coverage ahead p10 / p50_ - the coverage histogram over time.
- _Taps by kind and unreachable reason_ - `hb_video_tap` × `hb_video_tap_reason`.
- _Uncovered playing ms / s and failures_ - uncovered rate next to failures by stage.
- _Live Masking time per session p50 / p90_ - by tap kind; `none` sessions mask live throughout.
- _Transient Hit resolutions (content)_ - `hb.video.transient_runs` by resolution, including the
  Live Masking `live_suppressed` / `live_confirmed` buckets.

**Inference**

- _Inference round-trip (content)_ - p50 / p90 of `hb.inference.roundtrip_ms` (Live Masking frames,
  capture to verdict).
- _Inference run (background)_ - p50 / p90 of `hb.inference.run.duration` by media kind.
- _Inference requests / s_ by media kind and status (`success` | `error` | `cached`).
- _Inference queue depth_ - background queue size + in-flight.
- _Sampler encode p50 / p90 and frames sent_ - Firefox WebP encode cost and frames sent per transfer
  kind.

**Events and traces**

- _Session and tap events_ - Loki: `video.session.transition`, `video.tap.resolved`,
  `video.capture.failed`.

- _video.session umbrella traces_ - one per VideoSession; round-trips carry its id in
  `hb.session.trace_id`.
- _Slow inference round-trips_ - `inference.roundtrip` traces over 500 ms. Open one to see `capture`
  → `send` → `cache` → `queue.wait` → `run` → `apply`.

From any trace, "Logs for this span" queries Loki by `trace_id`; from any log line the `trace_id`
field opens the trace.

## Vocabulary in the stores

The extension emits OTel names; the stores rename them.

| In code (`ATTR` / `METRIC`)               | Prometheus                                 | Loki                                |
| ----------------------------------------- | ------------------------------------------ | ----------------------------------- |
| `hb.video.tap.sessions` (counter)         | `hb_video_tap_sessions_total`              | -                                   |
| `hb.video.uncovered_playing_ms` (counter) | `hb_video_uncovered_playing_ms_total`      | -                                   |
| `hb.video.coverage_ahead_sec` (histogram) | `hb_video_coverage_ahead_sec_bucket` / ... | -                                   |
| `hb.video.live_masking_ms` (histogram)    | `hb_video_live_masking_ms_bucket` / ...    | -                                   |
| `hb.lookahead.samples` (counter)          | `hb_lookahead_samples_total`               | -                                   |
| `hb.lookahead.failures` (counter)         | `hb_lookahead_failures_total`              | -                                   |
| `hb.inference.roundtrip_ms` (histogram)   | `hb_inference_roundtrip_ms_bucket` / ...   | -                                   |
| `hb.inference.run.duration` (unit `ms`)   | `hb_inference_run_duration_milliseconds_*` | -                                   |
| `hb.inference.requests` (counter)         | `hb_inference_requests_total`              | -                                   |
| attribute `hb.session.id`                 | label `hb_session_id`                      | structured metadata `hb_session_id` |
| resource `service.name`                   | `service_name` (also `job`)                | stream label `service_name`         |
| event name (log body)                     | -                                          | the line; filter with `             | =`/` | ~`  |
| `hb.context`, `browser.name`              | `target_info` only                         | `hb_context`, `browser_name`        |

Prometheus appends the unit only when the instrument declares one, which is why the content
histograms keep their `_ms` / `_sec` name and the background duration gains `_milliseconds`;
counters gain `_total`. Dots become underscores everywhere. `hb_session_id` in Loki is structured
metadata, so the dashboard's `=~ "$session"` filter sits after the stream selector
(`| hb_session_id=~"..."`), not inside it. The dashboard's queries are checked against `ATTR` and
`METRIC` by `utils/telemetry/__tests__/videoDashboard.test.ts`, so renaming a metric or attribute
fails the unit suite until the JSON follows.

Event names and their attributes are listed in [LOGGING.md](LOGGING.md) ("Video session events",
"Metrics").

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
