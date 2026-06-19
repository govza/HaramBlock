# Inference Pipeline

How a detected image becomes a set of masks: the background inference **implementation** - runtime
setup, the per-image stages, queueing, the single-run constraint, and adaptive batching. For the
model itself (classes, input/output shape, postprocessing, per-model accuracy/latency) see
[MODEL.md](MODEL.md).

## Overview: one image's journey

Content script detects an image -> sends it to the background over the MessageChannel transport ->
the background runs inference and sends predictions back -> the content script styles the element.

Background stages (per image):

1. **Cache check** - `InferenceOrchestrationService.scheduleInferenceTask` looks up cached
   predictions by `src` (IndexedDB). Hit -> return immediately, no inference.
2. **Enqueue** - miss -> a task enters `QueueService` with a priority (active tab first).
3. **Decode** - `prepareImage` turns the transferable `ImageBitmap` / blob / URL into a bitmap.
4. **Preprocess** - `preprocessImage` letterboxes to the model size and fills an NCHW float32
   tensor.
5. **Run** - `runSession` executes one `session.run` (GPU or WASM); the readback to CPU happens
   here.
6. **Postprocess** - per-pixel argmax/softmax -> per-class masks -> bbox -> RLE (details in
   MODEL.md).
7. **Cache + emit** - store predictions in IndexedDB, send them to the content script.
8. **Style** - the content script applies blur / mask overlays.

Steps 3-6 live in `utils/inference/runtimes/onnx/prediction.ts` (`processInferenceBatch`); steps 1-2
and 7 in `entrypoints/background/services/`.

## Runtime: ONNX Runtime Web in a service worker

The extension uses ONNX Runtime Web with the WebGPU backend (WASM fallback). Service workers impose
two restrictions that break standard ORT-web usage:

1. **No dynamic `import()`** - disallowed in `ServiceWorkerGlobalScope`. ORT internally uses
   `import()` to load its WASM loader module.
2. **No SharedArrayBuffer** - service workers aren't cross-origin isolated (no COOP/COEP), so SAB is
   unavailable; the standard ORT WASM loader needs it for multi-threading.

Workarounds:

- **Service-worker polyfills** - `utils/inference/serviceWorkerPolyfills.ts` is imported **before**
  any ORT import; it patches `window` and `XMLHttpRequest`.
- **WebGPU bundle** - we import `ort.webgpu.bundle.min.mjs`, which inlines the WASM glue and avoids
  the dynamic `import()` of the JS module.
- **Asyncify WASM preload** - we manually preload the asyncify WASM variant (async/await instead of
  SAB):

  ```typescript
  const WASM_PATH = '/ort/ort-wasm-simd-threaded.asyncify.wasm';
  ort.env.wasm.wasmBinary = await fetch(WASM_PATH).then(r => r.arrayBuffer());
  ```

- **Single-threaded config**:

  ```typescript
  ort.env.wasm.numThreads = 1; // no Web Workers in service workers
  ort.env.wasm.proxy = false; // direct execution, no worker proxy
  ```

### Backend selection

WebGPU is preferred whenever the browser exposes `navigator.gpu`, with WASM as the fallback. Decided
at runtime, so one build covers all platforms:

- **Chrome / Chromium**: WebGPU first, WASM fallback.
- **Firefox desktop (141+)**: WebGPU first (with the queue-poke workaround below), WASM fallback.
- **Firefox Android / browsers without WebGPU**: WASM (no `navigator.gpu`).
- **WebGPU session-creation failure** (blocklisted GPU, driver issues): automatic WASM fallback.

### WASM files

Copied from `node_modules/onnxruntime-web/dist/` to `ort/` in the build output via the
`build:publicAssets` hook in `modules/inference-runtime.ts`:

```
ort/
├── ort-wasm-simd-threaded.asyncify.mjs   # Asyncify JS glue
├── ort-wasm-simd-threaded.asyncify.wasm  # Asyncify WASM binary (preloaded at runtime)
├── ort-wasm-simd-threaded.mjs            # Standard JS glue
└── ort-wasm-simd-threaded.wasm           # Standard WASM binary
```

## The single-run constraint and the run mutex

onnxruntime-web cannot overlap `session.run` calls - the asyncify bundle has a single suspension
stack, and the JSEP bundle hangs (verified under `pnpm bench --concurrency=3`). The GPU is also one
device. So **exactly one `session.run` is ever in flight**, enforced by an async mutex
(`withRunLock`) in `runSession` (`utils/inference/runtimes/onnx/modelLoader.ts`).

Everything below is built around this: queue concurrency and batching overlap the _surrounding_ CPU
work and group images into one run - they never start two runs at once.

## Queue and concurrency

`QueueService` (p-queue, `entrypoints/background/services/queueService.ts`) holds pending tasks,
dequeued by **priority** (active tab first). Concurrency is **8**: enough in-flight tasks for
decode/preprocess/postprocess of several images to overlap the single GPU run, and enough for the
batch collector to fill a batch.

## Adaptive batching

Groups images into a single `session.run` to raise throughput on the GPU.

### How the batch size is decided

It is **not** tuned to the machine's spec:

```
batchSize = min(cap, images waiting in the queue when the GPU finishes its current run)
```

- **cap** is a fixed per-model ceiling (`computeBatchCap` in
  `utils/inference/shared/modelRegistry.ts`), applied only to dynamic-batch exports on WebGPU:

  | Model input | cap |
  | ----------- | --- |
  | 320         | 8   |
  | 448         | 4   |
  | 640         | 4   |

- the rest is driven by **backlog**, via the GPU-busy window below. The cap is the maximum; the
  actual batch is usually smaller.

### The GPU-busy window

Since only one run is in flight, images that arrive while a run is executing **accumulate**. When
the run finishes, the collector (`entrypoints/background/services/batchCollector.ts`) flushes up to
`cap` of the waiting images as the next batch. Batches therefore form naturally from whatever piled
up during the previous run.

```
t0   img A arrives, queue idle             -> flush [A]          (batch 1)
t1   run [A] starts on the GPU
t1.. imgs B,C,D,E,F arrive during run [A]  -> they wait
t2   run [A] done; 5 waiting               -> flush [B,C,D,E]    (batch 4 = cap)
t3   run [B..E] done; F still waiting       -> flush [F]          (batch 1)
```

- **Bursty page** (many images at once) -> batches fill toward the cap.
- **Trickle** (one image occasionally) -> mostly batch 1, with no added delay beyond one event-loop
  tick.

### It adapts to load, not to PC power

Counterintuitively, a **faster** GPU finishes each run sooner, so fewer images pile up between runs
-> **smaller** batches; a **slower** GPU lets more accumulate -> **larger** batches (still capped).
So batch size reacts to queue pressure, not to hardware strength. On one test machine the average
was ~4: at 448/640 that is the cap (queue stays saturated), and at 320 the cap is 8 but the average
is still ~4 because the 320 model drains the queue faster than it fills.

### No GPU (WASM) and static models -> no batching

`getBatchCap()` returns **1** (batching off) when:

- the backend is **WASM** - single-threaded CPU runs a batch of N as ~N sequential runs, so there is
  no throughput gain, only added latency; WASM keeps the per-image low-latency path.
- the model is a **static** export (`args.dynamic: false`) - its input batch dim is fixed at 1.

### Tradeoff and priority

A batch returns only once **all** its images finish, so an image waits on its slowest sibling -
batching trades per-image latency for throughput (good for bulk/background filtering). Priority is
preserved: the collector flushes the highest-priority waiting images first, so the active tab is
batched ahead of background tabs.

### Per-image accounting

`processInferenceBatch` amortizes the batch's wall time across its images
(`inferenceTime = batchTime / batchSize`) so the popup's throughput (`1000 / mean(inferenceTime)`)
reflects batching instead of undercounting by the batch size.

## Firefox 100ms readback poll + queue poke

Firefox polls WebGPU from a ~100ms timer rather than when work completes, so the `mapAsync` readback
ending every `session.run` stalls ~100ms regardless of model size. Workaround
(`utils/inference/runtimes/onnx/webgpuQueuePoker.ts`, Firefox+WebGPU only): submit empty command
buffers while a run is pending, which drains the readback in a few ms.

Open upstream at [Bugzilla 1870699](https://bugzilla.mozilla.org/show_bug.cgi?id=1870699). Once a
Firefox release fixes it (plain `webgpu` matches `webgpu-poke-t` under `pnpm bench`), delete the
poker and its branch in `runSession()`. Cold start still incurs a ~6.7s shader-compilation penalty
on Firefox (no pipeline cache).

## Known warnings

- **"powerPreference ignored"** - Chrome bug on Windows ([crbug.com/369219127]) - cosmetic, no
  functional impact.

## Standalone harness (`session.run` only)

`pnpm bench` (see `scripts/benchmark/README.md`) measures **pure** `session.run` latency in a
Playwright page - no decode/preprocess/postprocess/cache. Use it to reason about the GPU step in
isolation; use the popup stats (below) for end-to-end. Key findings: concurrent `session.run` hangs
(hence the run mutex); on Firefox only queue poking helps the 100ms wall; on Chromium graph capture
/ JSPI save only ~2-3ms over a ~12ms baseline. See [MODEL.md](MODEL.md) for the per-size tables.

## Observability

- **Popup -> Performance Statistics** (`entrypoints/popup/components/PerformanceStats.tsx`), over
  cached predictions:
  - **Detections** - total detections on total images.
  - **Inference** - median per-image `inferenceTime` (per-image share of the batch).
  - **Throughput** - `1000 / mean(inferenceTime)` (an inference-speed metric, not wall-clock).
  - **E2E** - median `e2eTime` (request -> result, includes queue wait).
  - **Batch** - average `batchSize`.
- **Wide events** (`utils/logging`) carry per-image `inferenceMs`, `e2eMs`, `batchSize`, `backend`,
  `modelId`. Enable the popup console toggle or use Copy Logs.

## File map

| Concern                           | File                                                               |
| --------------------------------- | ------------------------------------------------------------------ |
| Orchestration, cache, emit        | `entrypoints/background/services/inferenceOrchestrationService.ts` |
| Queue (priority, concurrency)     | `entrypoints/background/services/queueService.ts`                  |
| Batch collector                   | `entrypoints/background/services/batchCollector.ts`                |
| Model load, run mutex, backend    | `utils/inference/runtimes/onnx/modelLoader.ts`                     |
| Decode / preprocess / run / slice | `utils/inference/runtimes/onnx/prediction.ts`                      |
| Batch caps                        | `utils/inference/shared/modelRegistry.ts` (`computeBatchCap`)      |
| Firefox readback workaround       | `utils/inference/runtimes/onnx/webgpuQueuePoker.ts`                |
| Public API (incl. `getBatchCap`)  | `utils/inference/index.ts`                                         |
