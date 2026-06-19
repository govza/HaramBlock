# Phase 2 Real-World Results

## Correction (this supersedes the earlier "GPU is not the bottleneck" analysis)

An earlier version of this doc read the popup's **Throughput** as end-to-end wall-clock and
concluded the extension was "pipeline-bound" and batching didn't help. **That was wrong** - it
misread the metric. The numbers below are explained by a measurement bug in the Phase 2 batched
path, not a pipeline bottleneck.

## How the popup metrics are actually defined

From `entrypoints/popup/components/PerformanceStats.tsx`, over cached predictions:

```js
const totalInferenceMs = inferenceTimes.reduce((sum, t) => sum + t, 0);
const throughput = (totalImages / totalInferenceMs) * 1000; // == 1000 / mean(inferenceTime)
```

- **Inference** = median of per-image `inferenceTime`.
- **Throughput** = `1000 / mean(per-image inferenceTime)`.
- **E2E** = median of per-image `e2eTime` (request -> result, includes queue wait).

So **Throughput is derived from `inferenceTime`** - it is an inference-speed metric, not a
wall-clock pipeline metric. Inference and Throughput are the same quantity (median vs
mean-reciprocal).

## The bug: whole-batch time attributed to each image

The Phase 2 batched path set, for a batch of N images:

```js
const inferenceTime = inferenceEndAt - inferenceStartAt; // the WHOLE batch's time
// ...and assigned that same value to all N images
```

`sum(inferenceTime)` over a batch was therefore `N x batchTime` instead of `batchTime`, so
`throughput = 1000 / mean(inferenceTime)` **undercounts by the batch size N**. A batch of 8 reports
~8x worse throughput than reality. This is why the popup throughput _dropped_ after Phase 2:
pre-Phase 2 (single image) the metric was correct (320 ~= the harness batch-1 of 82.8/s); post-Phase
2 it read ~18/s because each image carried the full batch time.

**Fix:** amortize the batch's wall time across its images
(`perImageInferenceTime = batchTime / readyCount`). Then `sum(inferenceTime)` per batch ==
`batchTime` and throughput reflects batching.

## Measured (production build, Phase 2 batching on, BEFORE the fix)

These are the popup numbers with the undercount bug, so treat throughput/inference as ~Nx
pessimistic.

| Browser | size | Inference (median) | Throughput | E2E    | Detections |
| ------- | ---- | ------------------ | ---------- | ------ | ---------- |
| Chrome  | 320  | 47ms               | 17.9/s     | 619ms  | 69/79      |
| Chrome  | 448  | 53ms               | 18.0/s     | 631ms  | 74/79      |
| Chrome  | 640  | 114ms              | 9.0/s      | 1278ms | 77/79      |
| Firefox | 320  | 52ms               | 18.0/s     | 921ms  | 68/79      |
| Firefox | 448  | 75ms               | 12.7/s     | 1260ms | 72/79      |
| Firefox | 640  | 128ms              | 7.4/s      | 1859ms | 74/79      |

## Measured (production build, AFTER the per-image fix)

Firefox:

| size | Inference (median) | Throughput | E2E    | Detections | throughput vs before |
| ---- | ------------------ | ---------- | ------ | ---------- | -------------------- |
| 320  | 10ms               | 65.3/s     | 981ms  | 68/79      | 18.0 -> 65.3 (3.6x)  |
| 448  | 25ms               | 36.8/s     | 1465ms | 72/79      | 12.7 -> 36.8 (2.9x)  |
| 640  | 38ms               | 25.2/s     | 2088ms | 74/79      | 7.4 -> 25.2 (3.4x)   |

Chrome:

| size | Inference (median) | Throughput | E2E    | Detections | throughput vs before |
| ---- | ------------------ | ---------- | ------ | ---------- | -------------------- |
| 320  | 15ms               | 55.5/s     | 885ms  | 68/79      | 17.9 -> 55.5 (3.1x)  |
| 448  | 13ms               | 67.5/s     | 695ms  | 74/79      | 18.0 -> 67.5 (3.75x) |
| 640  | 21ms               | 43.5/s     | 1147ms | 77/79      | 9.0 -> 43.5 (4.8x)   |

The ~3-5x jump is the undercount being removed; batching was helping all along.

**Why Chrome 448 beats 320 (67.5 vs 55.5/s):** batch size is set by the GPU-busy window, so it
depends on backlog. The 320 model runs fast enough to drain the queue before many tasks accumulate
-> smaller batches -> less amortization; the slower 448 lets more tasks pile up per run -> bigger
batches. The actual batch size is now recorded per image (`processingTime.batchSize`, the wide-event
`batchSize`, and the popup "Batch avg" line) to confirm this.

## What is and isn't real

- **The earlier throughput "regression" was the metric undercounting by batch size**, now fixed.
- **Batching genuinely helps, most at small sizes, tapering at large ones.** Per-image
  `inferenceTime` = `preprocess_per_image + run/N`. Batching only shares the `run` term; the
  **canvas preprocess** (getImageData + JS tensor-fill) is a fixed per-image cost (~15ms at 640)
  that batching can't reduce, so absolute throughput is floored at high resolution.
- **E2E latency increase is real** (981ms -> 2088ms across sizes). A batch returns only once all its
  images finish - a real throughput-vs-latency tradeoff (e.g. keep the active tab's single image on
  the low-latency path, batch only backlog/video).
- **Detections (68 -> 72 -> 74 with size) are correct** and batched output slicing is sound.

## Next

1. Re-measure Chrome with the fix to confirm the same correction (expect a similar ~Nx jump).
2. Decide the latency tradeoff (lower caps, or batch only video frames where latency matters less).
3. Remaining levers: **preprocess cost** (the high-res floor - GPU preprocess or faster pixel
   extraction) and **Phase 3 ArgMax head** (cuts the readback inside the run, and the postprocess
   loop in E2E) - especially for Firefox at 640.
