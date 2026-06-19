# YOLO26n Semantic Segmentation Model

This doc covers the **model**: architecture, input/output, postprocessing, the registry of available
models, and per-model accuracy/latency. For how inference actually runs (runtime setup, backend
selection, queueing, batching, the Firefox readback workaround) see
[INFERENCE_PIPELINE.md](INFERENCE_PIPELINE.md).

## Architecture

- **Model**: YOLO26n-sem (Ultralytics)
- **Task**: Semantic segmentation
- **Format**: ONNX
- **Input Size**: 320×320 baseline; 448×448 / 640×640 available through model switching
- **Runtime**: ONNX Runtime Web (WebGPU with WASM fallback) - see
  [INFERENCE_PIPELINE.md](INFERENCE_PIPELINE.md)

## Input Specification

- **Shape**: `[N, 3, H, W]` (NCHW format, where `H×W` is the active model input size; `N` is the
  batch size - 1 for static exports, up to the batch cap for dynamic exports)
- **Type**: `float32`
- **Normalization**: 0-1 range (pixel / 255)
- **Letterbox padding**: Gray (114, 114, 114)

## Output Specification

Single output tensor — per-pixel class logits:

| Tensor    | Shape          | Description                                   |
| --------- | -------------- | --------------------------------------------- |
| `output0` | `[N, 4, H, W]` | Per-pixel logits for each class (NCHW layout) |

### Target Classes

| Index | Class        | Description            |
| ----- | ------------ | ---------------------- |
| 0     | background   | Background (not awrah) |
| 1     | aurat_female | Female awrah           |
| 2     | aurat_male   | Male awrah             |
| 3     | safe_person  | Safe person            |

### Postprocessing

```typescript
// For each pixel in the (letterbox-cropped) output:
// 1. Find argmax class across all channels
for (let c = 0; c < numClasses; c++) {
  logit = output0[c * H * W + y * W + x];
  if (logit > maxLogit) { maxLogit = logit; maxClass = c; }
}

// 2. If target class (aurat_female or aurat_male), compute softmax probability
if (isTargetClass(maxClass)) {
  prob = 1 / sum(exp(logit_c - maxLogit) for all c);  // numerically stable softmax
  if (prob >= scoreThreshold) mask[y][x] = 1;
}

// 3. Per-class masks are cropped to remove letterbox padding
// 4. Bounding box derived from mask pixel extents
// 5. Encode masks as RLE
```

For a batched run the output is sliced per image (`[N,...] -> N x [1,...]`) and each slice runs
through this same postprocessor - see [INFERENCE_PIPELINE.md](INFERENCE_PIPELINE.md).

### Mask RLE Encoding

Masks are stored using Run-Length Encoding (RLE) for efficient caching:

```typescript
interface IRLEMask {
  width: number; // Mask dimensions
  height: number;
  startValue: 0 | 1; // What the first run represents
  runs: number[]; // Alternating run lengths
}
```

**Example:** A mask `[0,0,0,1,1,1,1,0,0]` encodes as:

- `startValue: 0`
- `runs: [3, 4, 2]` → "3 zeros, 4 ones, 2 zeros"

**Why not COCO RLE?**

- COCO uses column-major order (MATLAB legacy) - we use row-major (natural for JS)
- COCO always starts with 0-count, requiring leading zeros when mask starts with 1s
- Our `startValue` field avoids this overhead

**Storage benefits:**

- Sparse masks (small detected regions) compress well
- Empty masks are essentially free: `{ runs: [] }`
- Self-contained format with embedded dimensions for portability

## Model Discovery System

Models are discovered dynamically at runtime from `metadata.yaml` files. This allows adding new
models without code changes.

### Adding a New Model

1. Create a directory under `public/models/` with naming convention: `{name}-y-{task}-{size}-{date}`
   (e.g. `afeef-y26-sem-320-20260607`)
2. Add the ONNX model file as `best.onnx`
3. Add a `metadata.yaml` with required fields (see below)
4. Add the path to `MODEL_PATHS` array in `utils/inference/shared/modelRegistry.ts`

### Directory Contract

Each model directory should contain:

```
public/models/{name}-y-{task}-{size}-{date}/
├── best.onnx                 # ONNX model
└── metadata.yaml             # Model metadata
```

### Required Metadata Fields

```yaml
id: sem-i320 # Unique model identifier
name: YOLO26n-sem 320×320 (4 classes) # Human-readable display name
task: semantic # 'semantic' or 'segment'
imgsz: # Input dimensions
  - 320
  - 320
names: # Class mapping
  0: background
  1: aurat_female
  2: aurat_male
  3: safe_person
```

### Model Loader API

```typescript
// Discover all available models (called automatically on init)
await discoverModels();

// Initialize with specific model
await initializeModel('sem-i320');

// Switch between models at runtime
await switchModel('sem-i320');

// Get current model ID
const id = getCurrentModelId();

// List all discovered models
const models = getAvailableModels();
```

## Available Models

| ID       | Directory                                  | Input Size | Output Size | Classes | Task     |
| -------- | ------------------------------------------ | ---------- | ----------- | ------- | -------- |
| sem-i320 | `public/models/afeef-y26-sem-320-20260607` | 320×320    | 320×320     | 4       | semantic |
| sem-i448 | `public/models/afeef-y26-sem-448-20260607` | 448×448    | 448×448     | 4       | semantic |
| sem-i640 | `public/models/afeef-y26-sem-640-20260607` | 640×640    | 640×640     | 4       | semantic |

These are `dynamic=True` exports (dynamic batch dim), which enables adaptive batching - see
[INFERENCE_PIPELINE.md](INFERENCE_PIPELINE.md).

### Model Selection

Model selection is **manual**. The popup's model toggle (`ModelToggle`) cycles through the available
models in ascending input-size order and persists the choice as `preference` in
`browser.storage.local` (key `modelSettings`), so it survives service-worker restarts.

On first run, before any choice is made, the startup default uses WebGPU API availability as a
proxy: browsers exposing `navigator.gpu` start at the balanced `sem-i448` (it runs ~25ms on WebGPU),
while browsers without WebGPU start at the `sem-i320` baseline (the registry `DEFAULT_MODEL_ID`,
since `sem-i448` is ~110ms on WASM). If WebGPU is present but the session falls back to WASM, the
selected model remains `sem-i448`; use the popup toggle to move down to `sem-i320` if the WASM path
is too slow. Switch up to `sem-i640` (highest quality) or down as needed from the toggle.

`sem-i640` is WebGPU-only in practice — on WASM it runs at ~247ms — so prefer `sem-i320` /
`sem-i448` without WebGPU. See the performance tables below for the size/latency trade-off per
backend.

The popup toggle border is color-coded by input size: `sem-i320` green, `sem-i448` yellow,
`sem-i640` red.

### Browser Performance (79 images)

Per-model end-to-end figures from the in-extension popup stats (single-image path, before adaptive
batching). Timings are size-dependent; detection counts may differ slightly across model weights.
For how these metrics are defined and the throughput gains from batching, see
[INFERENCE_PIPELINE.md](INFERENCE_PIPELINE.md).

**Chrome (WebGPU)**

| Model    | Detections | Inference | Throughput | E2E    |
| -------- | ---------- | --------- | ---------- | ------ |
| sem-i320 | 66/79      | ~22ms     | 42.3/s     | 1271ms |
| sem-i448 | 73/79      | ~25ms     | 34.2/s     | 1576ms |
| sem-i640 | 74/79      | ~36ms     | 26.8/s     | 1820ms |

**Firefox (WASM)**

| Model    | Detections | Inference | Throughput | E2E     |
| -------- | ---------- | --------- | ---------- | ------- |
| sem-i320 | 64/79      | ~58ms     | 16.8/s     | 4036ms  |
| sem-i448 | 72/79      | ~110ms    | 8.9/s      | 6444ms  |
| sem-i640 | 74/79      | ~247ms    | 4.0/s      | 11887ms |

**Firefox (WebGPU, NHWC, before queue-poking workaround)**

| Model    | Detections | Inference | Throughput | E2E    |
| -------- | ---------- | --------- | ---------- | ------ |
| sem-i320 | 64/79      | ~94ms     | 10.5/s     | 4039ms |
| sem-i448 | 72/79      | ~91ms     | 10.9/s     | 4199ms |
| sem-i640 | 74/79      | ~89ms     | 11.0/s     | 4226ms |

**Firefox (WebGPU + queue poking)**

| Model    | Detections | Inference | Throughput | E2E    |
| -------- | ---------- | --------- | ---------- | ------ |
| sem-i320 | 68/79      | ~18ms     | 49.7/s     | 1314ms |
| sem-i448 | 72/79      | ~22ms     | 38.2/s     | 1575ms |
| sem-i640 | 74/79      | ~36ms     | 24.0/s     | 2255ms |

With queue poking, Firefox WebGPU matches Chrome WebGPU and scales with model size again; the flat
~90-100ms above is the
[Firefox readback polling bug](INFERENCE_PIPELINE.md#firefox-100ms-readback-poll--queue-poke). Cold
start still incurs a ~6.7s shader compilation penalty (Firefox has no pipeline cache).

## Metadata Configuration

The `metadata.yaml` file contains model-specific configuration:

```yaml
# Required fields
id: sem-i320 # Unique model identifier
name: YOLO26n-sem 320×320 # Human-readable display name
task: semantic # 'semantic' for semantic seg, 'segment' for instance seg
imgsz:
  - 640
  - 640
names:
  0: background
  1: aurat_female
  2: aurat_male
  3: safe_person

# Optional fields (with defaults)
description: Ultralytics YOLO26n-sem model
author: Ultralytics
stride: 32 # Default: 32
batch: 1
args:
  dynamic: true # Dynamic batch export -> enables adaptive batching (see INFERENCE_PIPELINE.md)
output_shape: # Default: imgsz / stride
  - 320
  - 320
input_name: images # Default: 'images'
```

## Files

- `best.onnx` - ONNX model file
- `metadata.yaml` - Model metadata (classes, configuration)
