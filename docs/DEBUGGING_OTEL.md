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

Dashboard variable **VideoSession** (`hb_session_id`) filters every per-session DVR panel and every
Loki panel (as a structured-metadata filter after the line filters); "All" overlays sessions. The
rollup tiles and "(all sessions)" panels ignore it on purpose. Time range defaults to the last 15
minutes with 5 s refresh.

**Playback health** (stat row, all sessions, over the dashboard range)

The one-glance answer to "is playback healthy right now". Every tile reads "no data" while nothing
plays (zero active windows), so an idle dashboard is never green.

- _Health %_ - healthy windows / active windows. Green >= 97 %, orange >= 90 %, red below. The
  definition is the `HEALTHY_*` constants in `probeCore.ts`: active, presented (new + repeat)
  > = 0.9 x captured, no long task > 100 ms, no freeze, no audio underrun.
- _Freeze seconds_ - active windows without a new frame. A paused video is inactive and never
  counts; a non-zero value with fps at 0 is a frozen presenter, not a pause.
- _Drops per minute_ - `captured - presented - repeated` per active minute. This is where the ~10 %
  loss of a 60 fps `tap` session shows up although it never trips the 0.75 anomaly ratio.
- _Audio fallback %_ - windows on relay or with audio unavailable, over all routed windows.
- _Anomalies per 10 min_ - `video.dvr.anomaly` dumps per 10 active minutes, comparable across
  sessions of any length.
- _Warmup p90_ - `hb.dvr.warmup_ms` with status `ready`: how long a viewer stares at the warm-up
  blur before the first filtered frame.

**DVR (per VideoSession)**

- _Captured vs presented fps_ - the DVR's two 1 s-window rates. Presented tracking captured means
  the delay line keeps up. Presented < 0.75 x captured for 2 consecutive windows is the fps anomaly
  trigger; the first 2 windows after a run start or playback resume are warm-up and are skipped.
- _Source vs captured fps_ - `hb.dvr.source_fps` is what the browser delivered (distinct
  mediaTimes); captured below it is the capture throttle (raw ring cadence ~30 fps) or a capture
  that failed. Source below the media's frame rate is the browser skipping frames - see the skipped
  / late panel.
- _Capture vs native size (px)_ - the ring capture geometry actually applied (ladder tier) against
  the element's `videoWidth` / `videoHeight`. Capture above native is an upscale: wasted capture
  cost and ring bytes. Native at 0 means the DVR started before metadata.
- _Capture draw / Capture transfer_ - the raw-store capture cost split into drawImage and
  transferToImageBitmap (both 0 on the encoded store). On Firefox the raw store is the fallback when
  the software-encoder probe fails, and this is where its per-frame main-thread cost shows.
- _Frame delivery gap (ms)_ - wall gap between new-frame deliveries. Bands above the frame interval
  are callbacks held back by main-thread work; Firefox has no `longtask` observer, so this panel
  stands in for _Main-thread long tasks_ there.
- _Deduped ticks_ - deliveries that repeated the previous mediaTime. Observed ~0 on both browsers
  under rVFC; anything non-zero on Chrome is a tap reporting a stale currentTime.
- _Source frames skipped / late ticks_ - rollup by browser / store / tap: how many source frames
  never reached us, and how often a delivery was late.
- _Sampler encode / frames sent_ - `bitmapToCompressedBlob` cost (Firefox blob transport) and the
  inference sampling rate; the other main-thread consumer next to the DVR capture.
- _Ring flushes / source backsteps_ - `hb.dvr.ring_flushes` by cause and `hb.dvr.source_backsteps`
  by size in frame intervals (rollups). A backstep bar without a flush bar is a re-delivered stale
  frame the store absorbed (anything under `STALE_FRAME_TOLERANCE_SEC`, 0.5 s absolute - the size
  buckets are frame-relative, so a `seek` bucket at 60 fps can still be absorbed); a flush bar means
  the ring emptied and the session is about to pin for `D`. On Firefox a 1-frame backstep every
  15-40 s is the rVFC re-delivering an older frame, not a seek - expect backstep bars with no
  matching flush bars.
- _Pinned vs frozen windows_ - `hb.dvr.pinned_windows` (presenter waiting for the ring to span `D`)
  next to `hb.dvr.freeze_windows`. Frozen and pinned = ring refill (after a flush or seek); frozen
  and not pinned = decode or present problem.
- _DVR main-thread ms per second_ - `hb.dvr.main_thread_ms`: capture + present time per 1 s window.
  1000 is the whole budget; above ~400 the rVFC callbacks start arriving late and _Source frames
  skipped_ climbs. Firefox raw capture at 1916 px wide spends ~600 ms/s here.
- _Main-thread loop lag_ - heatmap of `hb.main_thread.loop_lag_ms`, the 250 ms `setTimeout` drift
  while a DVR presents in a visible tab. The Firefox stand-in for _Main-thread long tasks_: a lag >
  100 ms is treated as a long task there (health definition and `long_task` anomaly).
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
- _Playback active / verdict margin_ - `hb.dvr.playback_active` (1/0) resolves whether a 0 fps
  session is paused or frozen; verdict margin = D - observed round-trip p90 (right axis), the
  headroom before the DVR presents an unjudged frame.
- _A/V drift (ms)_ - `hb.audio.drift_ms` by route. Relay drifts past +-250 ms are corrected by a
  seek (counted as an underrun); the delay line shows the DelayNode ramp catching up with D.
- _Frame drops / freezes per second_, _Healthy vs active windows per second_, _Audio route windows /
  underruns_, _DVR runs started / stopped by reason, anomalies by cause_ - the rollup counters
  behind the stat row, by `hb_dvr_store` / `hb_dvr_tap` (and `hb_audio_route`, `hb_dvr_reason`,
  `hb_dvr_cause`), never by session.
- _DVR anomaly dumps_ - Loki: `video.dvr.anomaly` headers and their `video.dvr.tick` rows (last 5 s
  of per-tick records, one dump per 10 s per session, grouped by `hb_dvr_anomaly_id`). Expand a row
  for the `hb_dvr_tick_*` fields (`outcome` new|repeat|miss, `pinned`, `ring_span_sec`; a negative
  `media_delta` is a backstep); the `trace_id` field links into Tempo. Structured-metadata filters
  work on them: `| hb_dvr_tick_media_delta < 0` lists every backstep, `| hb_dvr_tick_outcome="miss"`
  every unserved target.
- _Session + DVR events_ - every other `video.*` event: `video.session.transition` (phase, DVR
  sub-state, audio route), `video.dvr.start` / `stop` / `tap_changed` / `store_demoted` / `underrun`
  / `budget_degraded` / `budget_recovered`, `video.audio.route`, `video.capture.failed`.
  `video.dvr.start` says why the push tap is not in use (`hb_dvr_tap_reason`) and every lifecycle
  record why the store is raw or encoded (`hb_dvr_store_reason`). `video.dvr.ring_flushed` carries
  the cause (backstep | store | swap), the previous and offending capture keys and the buffered
  seconds the flush discarded.

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

| In code (`ATTR` / `METRIC`)              | Prometheus                                     | Loki                                |
| ---------------------------------------- | ---------------------------------------------- | ----------------------------------- |
| `hb.dvr.captured_fps` (gauge)            | `hb_dvr_captured_fps`                          | -                                   |
| `hb.dvr.playback_active` (gauge)         | `hb_dvr_playback_active`                       | -                                   |
| `hb.dvr.verdict_margin_sec` (gauge)      | `hb_dvr_verdict_margin_sec`                    | -                                   |
| `hb.audio.drift_ms` (gauge)              | `hb_audio_drift_ms`                            | -                                   |
| `hb.dvr.capture_ms` (histogram)          | `hb_dvr_capture_ms_bucket` / `_sum` / `_count` | -                                   |
| `hb.dvr.warmup_ms` (histogram)           | `hb_dvr_warmup_ms_bucket` / `_sum` / `_count`  | -                                   |
| `hb.dvr.active_windows` (counter)        | `hb_dvr_active_windows_total`                  | -                                   |
| `hb.dvr.healthy_windows` (counter)       | `hb_dvr_healthy_windows_total`                 | -                                   |
| `hb.dvr.freeze_windows` (counter)        | `hb_dvr_freeze_windows_total`                  | -                                   |
| `hb.dvr.frames_dropped` (counter)        | `hb_dvr_frames_dropped_total`                  | -                                   |
| `hb.dvr.runs_started` (counter)          | `hb_dvr_runs_started_total`                    | -                                   |
| `hb.dvr.runs_stopped` (counter)          | `hb_dvr_runs_stopped_total`                    | -                                   |
| `hb.dvr.anomalies` (counter)             | `hb_dvr_anomalies_total`                       | -                                   |
| `hb.dvr.ring_flushes` (counter)          | `hb_dvr_ring_flushes_total`                    | -                                   |
| `hb.dvr.source_backsteps` (counter)      | `hb_dvr_source_backsteps_total`                | -                                   |
| `hb.dvr.pinned_windows` (counter)        | `hb_dvr_pinned_windows_total`                  | -                                   |
| `hb.main_thread.loop_lag_ms` (histogram) | `hb_main_thread_loop_lag_ms_bucket` / ...      | -                                   |
| `hb.audio.route_windows` (counter)       | `hb_audio_route_windows_total`                 | -                                   |
| `hb.audio.underruns` (counter)           | `hb_audio_underruns_total`                     | -                                   |
| `hb.audio.unavailable_windows` (counter) | `hb_audio_unavailable_windows_total`           | -                                   |
| `hb.inference.run.duration` (unit `ms`)  | `hb_inference_run_duration_milliseconds_*`     | -                                   |
| `hb.inference.requests` (counter)        | `hb_inference_requests_total`                  | -                                   |
| attribute `hb.session.id`                | label `hb_session_id`                          | structured metadata `hb_session_id` |
| resource `service.name`                  | `service_name` (also `job`)                    | stream label `service_name`         |
| event name (log body)                    | -                                              | the line; filter with `             | =`/` | ~`  |
| `hb.context`, `browser.name`             | `target_info` only                             | `hb_context`, `browser_name`        |

Prometheus appends the unit only when the instrument declares one, which is why the DVR histograms
keep their `_ms` name and the background duration gains `_milliseconds`; counters gain `_total`.
Dots become underscores everywhere. `hb_session_id` in Loki is structured metadata, so the
dashboard's `=~ "$session"` filter sits after the stream selector (`| hb_session_id=~"..."`), not
inside it. The dashboard's queries are checked against `ATTR` and `METRIC` by
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
