# Logging & Telemetry

HaramBlock has one logging philosophy — **wide events** (canonical log lines): instead of scattering
log statements through the pipeline, one comprehensive event is emitted per processed image carrying
every field you might need to debug it. Ad-hoc diagnostics go through a single `consola` facade. In
dev builds, both feed an **OTLP exporter** so traces and logs can be viewed in external tools
(otel-tui, Jaeger, Grafana).

## Architecture

```
Content script                       Background service worker
──────────────                       ─────────────────────────
contentTiming (per-src state)        inferenceOrchestrationService
  start → markSent → markReceived      cache check / queue / inference
  → completeContentTiming              → emitEvent (background context)
  → emitEvent (content context)              │
        │ RPC (comctx)                       ▼
        └────────────────────────────► mergeContentEvent (by reqId)
                                             │
                             ┌───────────────┼─────────────────────┐
                             ▼               ▼                     ▼
                      storage.session   JSON console line   OTLP exporter (dev)
                      (last 500,        (one line per       traces → :4318/v1/traces
                       Copy Logs)        merged event)      logs   → :4318/v1/logs

logger.withTag('...').info/warn/error  ──────────────────►  OTLP logs (dev, via
(consola facade, all contexts)                              runtime message → SW)
```

## Wide events

One `WideEvent` per image, correlated across contexts by `reqId` (4-char FNV-1a hash of the image
URL). Content timing is merged into the matching background event so the stored record has the
complete picture. Schema: `utils/logging/types.ts`.

Diagnostic fields (every terminal event):

| Field    | Values                                                              | Answers                             |
| -------- | ------------------------------------------------------------------- | ----------------------------------- |
| `status` | `success` / `error` / `skipped` / `cached`                          | what happened                       |
| `reason` | `below-min-size`, `decode-rejected`, `load-error`, `send-failed`, … | why it was skipped / what failed    |
| `stage`  | `queued` / `sent` / `received` / `styled`                           | how far it got before terminating   |
| `source` | `inference` / `db-cache` / `memory-cache`                           | where the applied verdict came from |

Timing fields: background `queueMs/fetchMs/decodeMs/inferenceMs/e2eMs`, content
`sendMs/waitMs/styleMs`. Result fields: `detectionsCount`, `batchSize`, `cacheHit`, `overlayType`,
`backend`, `modelId`, `error {message,type}`.

### Console output is single-line JSON

When console logging is enabled (dev, or the popup terminal toggle), each merged event is logged as
**one line**: human summary + full JSON payload:

```
[f7a2] success example.com +165ms stage=styled {"reqId":"f7a2","src":"…","inferenceMs":120,…}
```

This is deliberate: the Playwright MCP console capture flattens any logged _object_ to the literal
string `Object`. One-line JSON survives. Follow the same rule for any debug logging you add
(`logger.debug(\`thing ${JSON.stringify(payload)}\`)`).

### Reading events from automation

`browser_console_messages` only sees page consoles — the MV3 service worker is invisible. Two escape
hatches:

- **`__hbDumpEvents(n)`** (dev builds): evaluate on `chrome-extension://<id>/popup.html` via
  `browser_evaluate`; returns the last _n_ wide events as a JSON string
  (`utils/logging/devDump.ts`).
- **Copy Logs** button in the popup performance panel: full buffer to clipboard.

### Invariant warnings

Cheap self-checks that turn known bug signatures into one warn line:

- `prediction`: element-reported dims vs decoded bitmap dims skew >2% (`resolveBitmap`) — the srcset
  density-corrected `naturalWidth` signature.
- `imageCacheService`: at cache write, `(mask.width − 2·offsetX)·scaleX` must land on
  `prediction.width` (mask grid ↔ image dims self-consistency).
- `overlayLayer`: warns when site CSS computes the layer host to `visibility: hidden` /
  `display: none` (e.g. `:not(:defined)` FOUC guards) — checked on tracker ticks, 1 s throttle.
- `maskOverlay`: per-render JSON snapshot (contentRect, maskTransform, natural dims, grid dims,
  objectFit), deduped per element until inputs change. Debug level, so visible only when console
  logging is on.

## The consola facade (`utils/logger.ts`)

All ad-hoc logging goes through `logger.withTag('<module>').debug/info/warn/error(...)`. Never use
raw `console.*` in extension code (ESLint enforces this). Output is gated by
`import.meta.env.DEV || logSettings.consoleEnabled`. In dev builds, info/warn/error records are also
forwarded to the OTLP exporter (tagged with `log.tag` and `extension.context`).

## OTLP export (dev builds only)

Dev builds can ship traces + logs to any OTLP/HTTP collector on localhost. Production builds contain
none of this code (DEV-guarded dynamic imports; verify with
`grep -r OtlpExporter .output/chrome-mv3` after a build).

**Quickstart with [otel-tui](https://github.com/ymtdzzz/otel-tui):**

```bash
brew install ymtdzzz/tap/otel-tui   # or: go install github.com/ymtdzzz/otel-tui@latest
otel-tui                            # OTLP receiver on :4318, TUI opens
pnpm dev                            # or pnpm build + load the dev output
# popup → performance panel → antenna icon (data-testid="otlp-toggle")
```

Browse an image-heavy page; traces appear per image. Settings live in
`browser.storage.local.logSettings`: `otlpEnabled` (default false) and `otlpEndpoint` (default
`http://localhost:4318`). No manifest changes needed — `<all_urls>` host permission covers
localhost, so the SW `fetch` bypasses CORS.

Verified-the-hard-way gotchas (encoded in the implementation, kept here so they aren't re-learned):

- **No dynamic `import()` in the MV3 service worker.** Telemetry is statically imported with
  `import.meta.env.DEV` guards; a DEV-gated dynamic import builds fine and then silently never loads
  in the SW.
- **Chromium caches the unpacked extension's SW script.** After redeploying a build over the same
  path/version, reload the extension (or wipe the automation profile) — a browser relaunch is not
  always enough, and the stale SW has no telemetry.
- **`__hbTelemetryState()`** (dev): evaluate in the SW (or any context) to see
  `{exporterActive, pendingCount, backgroundEvents, mergedEvents, contentOnlyEvents, logRecords, exported}`
  — first stop when traces don't show up.
- For MCP-driven verification, build with `pnpm exec wxt build --mode development` (output in
  `.output/chrome-mv3-dev`) — the regular `pnpm build` is production and contains no telemetry.

### Trace shape

Each processed image becomes one trace; the 4-char `reqId` is exported as the `req_id` attribute for
correlating re-processings of the same URL. A background event reserves a traceId and waits up to 10
s for its content merge; events that never merge (cache hits, video/GIF frames) export
background-only.

```
image.process                    ← root; ALL wide-event fields as snake_case attributes
├─ content.send
├─ content.wait
│  └─ background.process
│     ├─ background.queue        ← sequential chain reconstructed from durations
│     ├─ background.fetch
│     ├─ background.decode
│     └─ background.inference
└─ content.style
```

Per trace, one **wide log record** is also emitted (the canonical log line: all attributes,
correlated via `traceId`/`spanId`), plus any consola records. Error events set span status `ERROR`
with the message.

Known imprecision: durations come from `performance.now()` deltas but anchors from `Date.now()` in
two JS contexts, so `background.process` can poke slightly outside `content.wait`. Accepted — not
clamped.

### Key files

- `utils/telemetry/otlpJson.ts` — id/timestamp/attribute encoding (nanos are BigInt-derived
  **strings**; traceId 32 hex, spanId 16 hex; enums as ints)
- `utils/telemetry/wideEventToOtlp.ts` — wide event → span tree + wide log record
- `utils/telemetry/otlpExporter.ts` — zero-dependency batching exporter (2 s flush, drop on failure
  with rate-limited warn; never logs through `logger` — loop risk)
- `utils/telemetry/telemetry.ts` — background orchestrator: pending-merge map, settings sync,
  runtime-message listener for forwarded consola records

## Two separate systems (unchanged)

1. **Wide events** — ephemeral debug output in `browser.storage.session` (last 500), exported via
   Copy Logs / `__hbDumpEvents` / OTLP.
2. **Prediction cache** — persistent per-image records in IndexedDB (`IImagePrediction`, including
   `processingTime`), which also powers the popup PerformanceStats panel.

## Design decisions

| Decision                              | Rationale                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------- |
| Hash URL for reqId                    | Stable ID — same image always has same reqId                              |
| Random traceId per processing attempt | Same image can be processed many times; reqId attribute links them        |
| `browser.storage.session` for events  | Ephemeral, shared across contexts, no disk I/O                            |
| Single-line JSON console output       | Object logs flatten to `Object` in MCP console capture                    |
| OTLP dev-only, localhost-only         | Extension processes browsing data; telemetry must never leave the machine |
| Hand-rolled OTLP JSON exporter        | ~150 lines, zero deps; official browser SDK is experimental and heavy     |
| Drop failed export batches            | Dev tooling; the extension must never degrade because a collector is down |
