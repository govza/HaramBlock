# Plan: Parallel GPU Inference

**Status: planned.** Builds on the `firefox-webgpu` branch (queue-poking workaround, benchmark
harness). Measurements below are from `pnpm bench` on NVIDIA Ampere / Windows 11, June 2026.

## Goal

Increase inference throughput by parallelizing GPU processing of images, without regressing
single-image latency on the active tab.

## What does NOT work (measured)

- **Concurrent `session.run` in onnxruntime-web** - hangs on the asyncify bundle (single suspension
  stack) AND on the JSEP bundle (verified with
  `pnpm bench -- --concurrency=3 --configs=webgpu-jsep`: never completes). No ORT-web bundle
  supports overlapping runs on a session. Any design must keep exactly one `session.run` in flight.
- **Web Workers** - Chrome MV3 service workers cannot spawn `Worker`s; stable Firefox has no WebGPU
  in workers. A Chrome offscreen-document host is possible but heavy and Chrome-only.

## Where the time goes (per image, `session.run` split)

| Browser         | 640 total | compute | readback | output size      |
| --------------- | --------- | ------- | -------- | ---------------- |
| Chromium        | 16.2ms    | 10.4ms  | 5.7ms    | 6.5MB f32 logits |
| Firefox (poked) | 35.8ms    | 22.2ms  | 13.6ms   | 6.5MB f32 logits |

The `[1,4,H,W]` float32 logits readback is 35-40% of the per-image cost. In the extension, decode ->
canvas preprocess -> run -> JS argmax postprocess all run serially per image (`QueueService`
concurrency 1).

## Levers

| #   | Lever             | Layer           | Expected gain               | Cost                        |
| --- | ----------------- | --------------- | --------------------------- | --------------------------- |
| 1   | Pipeline overlap  | extension queue | hide ~5-15ms CPU work/image | small, no model change      |
| 2   | Batched inference | model + queue   | ~2-2.5x throughput          | re-export + batch collector |
| 3   | ArgMax on GPU     | model graph     | cut readback 3.6-23ms/image | export change, op check     |

## Phases

### Phase 0 - validate in the harness (gate for Phases 2-3)

No extension changes. Export test models with Ultralytics:

- `dynamic=True` for dynamic batch (`[N,3,H,W]`)
- a variant with an ArgMax head appended: output `[N,H,W]` uint8 instead of `[N,4,H,W]` f32 (16x
  smaller readback; 64x if emitted at /4 resolution, where postprocess already subsamples)

Extend `scripts/benchmark/run.mjs` with `--batch=1,2,4,8` configs and the new model paths. Measure
both browsers.

**Harness done** (`--batch` / `--variant`, per-image latency + throughput, output-tensor
dtype/dims/bytes reporting - see `scripts/benchmark/README.md`).

**Dynamic-batch validated** (`pnpm bench --batch=1,2,4,8 --variant=20260607`, 20 runs, NVIDIA Ampere
/ Windows 11, June 2026). Per-image throughput (imgs/s), speedup vs batch 1 in parens:

| Browser          | size | b1   | b2         | b4         | b8         |
| ---------------- | ---- | ---- | ---------- | ---------- | ---------- |
| Chrome (webgpu)  | 320  | 82.8 | 144 (1.7x) | 222 (2.7x) | 317 (3.8x) |
| Chrome (webgpu)  | 448  | 72.4 | 113 (1.6x) | 158 (2.2x) | 173 (2.4x) |
| Chrome (webgpu)  | 640  | 53.6 | 76 (1.4x)  | 86 (1.6x)  | 86 (1.6x)  |
| Firefox (poke-t) | 320  | 37.9 | 68 (1.8x)  | 116 (3.1x) | 195 (5.1x) |
| Firefox (poke-t) | 448  | 37.2 | 54 (1.5x)  | 66 (1.8x)  | 85 (2.3x)  |
| Firefox (poke-t) | 640  | 26.6 | 34 (1.3x)  | 46 (1.7x)  | 59 (2.2x)  |

Takeaways: batching wins on both browsers, more at smaller resolutions and more on Firefox (fixed
poke/IPC overhead amortizes). Chrome plateaus by batch 4 at 640 (1.6x); Firefox keeps climbing.
Per-call latency grows with batch (e.g. Chrome 640 b8 = 93ms) while per-image latency drops - so the
active tab's single image must still run at batch 1 (Phase 2's "queue empty -> batch 1" path).
Suggested Phase 2 caps: 8@320, 4@448, 4@640.

**Risks - status:**

- Batch memory: no OOM through batch 8 @ 640 on Ampere (52MB f32 output). Safe max batch >= 8 at all
  sizes on this GPU; revisit on weaker hardware.
- ArgMax-on-GPU: **still open** - no ArgMax-head model was exported (only `dynamic=True`). Output is
  still `float32[N,4,H,W]` logits (1.64MB@320 -> 52MB@640 b8). Phase 3 needs that export to measure.
- Graph capture vs dynamic batch: not tested (accepted as forfeit; capture was only ~2-3ms on
  Chrome).

### Phase 1 - pipeline overlap (ship first, independent of Phase 0) - DONE

Raise `QueueService` concurrency to 2-3, wrap `session.run` in an async mutex so only one GPU run is
in flight (required - see hang above). Image N+1's decode/preprocess and image N-1's
postprocess/cache then overlap the GPU run. Cheapest win, helps both browsers immediately.

Touch points: `entrypoints/background/index.ts` (queue concurrency),
`utils/inference/runtimes/onnx/modelLoader.ts` (`runSession` mutex).

Implemented: `INFERENCE_CONCURRENCY = 3` in `index.ts`; `withRunLock` serial mutex around
`runSession` in `modelLoader.ts`. Re-measure E2E in `MODEL.md` after the next build.

### Phase 2 - adaptive batching (the actual parallel GPU processing)

A batch collector between the queue and the inference call:

- Queue has backlog -> accumulate up to N tasks (N by model size from Phase 0, e.g. 8@320,
  4@448/640), preprocess into one `[N,3,H,W]` tensor, single `session.run`, split outputs per task.
- Queue empty -> run immediately with batch 1, so active-tab single-image latency never regresses;
  bulk pages get the throughput.

This amortizes exactly the fixed costs that dominate: Firefox's poke/IPC overhead and Chrome's
per-dispatch cost. Ballpark from the split data: ~1.8x Chrome, ~2-2.5x Firefox at batch 4. Priority
ordering (active tab first) is preserved by flushing in priority order.

Touch points: new `BatchCollector` between `QueueService` and `processInferenceTask`,
`preprocessing.ts` (batched tensor fill), `prediction.ts` (per-image output slicing), model metadata
(`batch` field already exists in `metadata.yaml`).

### Phase 3 - ArgMax-head models (if Phase 0 confirms GPU support)

Ship re-exported models with the ArgMax head: readback drops to ~0.1-0.4MB and the JS argmax/softmax
postprocess loop disappears. Same export as the dynamic-batch models, so this combines with Phase 2.

## Notes

- Video frames benefit most from batching (steady stream of frames).
- Keep the Firefox queue poker active for batched runs - the 100ms poll wall applies to any readback
  (see "Firefox Bug: 100ms GPU Device Polling" in `MODEL.md`).
- Re-measure the extension E2E numbers in `MODEL.md` after each phase.
