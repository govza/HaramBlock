# ORT WebGPU Benchmark Harness

Standalone benchmark for ONNX Runtime Web session configurations across Chromium and Firefox, driven
by Playwright. Serves the repo over localhost (models from `public/models/`, ORT bundles from
`node_modules`) and measures `session.run` latency in a real browser page.

## Usage

```bash
pnpm bench                                    # full matrix, both browsers, all sizes
pnpm bench -- --browsers=firefox --sizes=320  # focused run
pnpm bench -- --configs=webgpu,webgpu-poke-t --runs=30 --warmups=5
pnpm bench -- --concurrency=4 --verbose
pnpm bench -- --batch=1,2,4,8 --configs=webgpu  # batched throughput sweep
```

Results print as a markdown table and are saved as JSON under `scripts/benchmark/results/`.

## Batched inference

`--batch=1,2,4,8` runs each config with an `[N,3,H,W]` input and reports per-image latency
(`img(ms)`) and per-image throughput (`imgs/s`) alongside the per-call figures, so batches compare
directly against batch 1. The table also prints each run's output tensors
(`dtype[dims]@location bytes`) — use this to confirm an ArgMax-head export shrank the readback and
stayed on the WebGPU EP (a CPU-EP fallback shows up as a larger readback).

Batch > 1 requires a **dynamic-batch** model export (`dynamic=True`); a static-batch export errors
with `Got invalid dimensions for input`. The models under `public/models` are dynamic-batch, so the
default per-size selection works. `--variant=<token>` substring-matches the model dir name to pick a
specific export when several share a size.

## Configs

| Name                | Bundle               | Notes                                             |
| ------------------- | -------------------- | ------------------------------------------------- |
| `wasm`              | native EP (asyncify) | CPU baseline, single-threaded                     |
| `webgpu`            | native EP (asyncify) | Matches the extension's current setup             |
| `webgpu-gpuout`     | native EP (asyncify) | `preferredOutputLocation: 'gpu-buffer'` + getData |
| `webgpu-gc`         | native EP (asyncify) | Graph capture (GPU input + output required)       |
| `webgpu-jspi[-gc]`  | native EP (JSPI)     | Chrome-only; Firefox stable lacks JSPI            |
| `webgpu-jsep[-...]` | JSEP (`ort.bundle`)  | JS-based WebGPU EP                                |
| `webgpu-nchw`       | native EP (asyncify) | `preferredLayout: 'NCHW'`                         |
| `webgpu-poke-*`     | native EP (asyncify) | Firefox readback workaround (`-t`/`-c`/`-raf`)    |

## Key findings (June 2026, NVIDIA Ampere, Windows 11)

- **Firefox WebGPU pins at ~100ms per inference regardless of model size or config** (320/448/640,
  graph capture, JSEP, JSPI — all identical). Timing split shows run≈1ms, readback≈99ms: Firefox
  (wgpu) only delivers `mapAsync` readbacks on an internal ~100ms device poll tick.
- **Submitting empty command buffers while a run is pending forces the poll** and cuts latency to
  ~25–35ms (`webgpu-poke-*` configs). This is what the extension ships in
  `utils/inference/runtimes/onnx/webgpuQueuePoker.ts`.
- Chromium: graph capture and JSPI each shave ~2–3ms off a ~12ms baseline; not worth the GPU-tensor
  I/O complexity for this workload.
- Concurrent `session.run` calls hang the asyncify bundle (single suspension stack) — keep queue
  concurrency at 1.
- ONNX Runtime creates a **new GPUDevice** after the last session is released and another is created
  (model switch). Poking the stale device's queue does nothing — fetch `ort.env.webgpu.device` fresh
  for every run. `switch-test.mjs` reproduces this (stale device: 100ms, fresh device: ~40ms).
- The 100ms wall is Firefox's timer-based device polling (`POLL_TIME_MS = 100` in
  `dom/webgpu/ipc/WebGPUParent.cpp`,
  [Bugzilla 1900273](https://bugzilla.mozilla.org/show_bug.cgi?id=1900273),
  [wgpu #6660](https://github.com/gfx-rs/wgpu/issues/6660)). Empty `queue.submit([])` works because
  wgpu's `Queue::submit` runs `device.maintain(Poll)` and fires pending map callbacks — the same
  step the timer runs. The proper fix
  ([Bugzilla 1870699](https://bugzilla.mozilla.org/show_bug.cgi?id=1870699)) is stalled on a race
  condition.
- Playwright's Firefox needs `dom.webgpu.enabled` pref (set automatically by the runner). Its WASM
  performance is not representative of release Firefox; use it only for WebGPU comparisons.
