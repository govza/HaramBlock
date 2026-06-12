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

**Risks to answer here:**

- Does ORT's WebGPU EP run ArgMax on GPU? If it falls back to the CPU EP it forces an earlier,
  larger readback and loses.
- Batch memory at 640 (input alone is 4.9MB/image f32 + activations) - find the safe max batch per
  model size.
- Graph capture requires static shapes - dynamic batch likely forfeits it (acceptable; capture was
  only worth ~2-3ms on Chrome).

### Phase 1 - pipeline overlap (ship first, independent of Phase 0)

Raise `QueueService` concurrency to 2-3, wrap `session.run` in an async mutex so only one GPU run is
in flight (required - see hang above). Image N+1's decode/preprocess and image N-1's
postprocess/cache then overlap the GPU run. Cheapest win, helps both browsers immediately.

Touch points: `entrypoints/background/index.ts` (queue concurrency),
`utils/inference/runtimes/onnx/modelLoader.ts` (`runSession` mutex).

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
