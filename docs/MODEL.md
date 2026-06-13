# YOLO26n Semantic Segmentation Model

## Inference Runtime

The extension uses ONNX Runtime Web with WebGPU backend (WASM fallback) for AI inference.

### Service Worker Limitations

Service workers have two critical restrictions that break standard ONNX Runtime Web usage:

1. **No dynamic `import()`** - The HTML specification disallows dynamic imports in
   ServiceWorkerGlobalScope. ONNX Runtime internally uses `import()` to load its WASM loader module.

2. **No SharedArrayBuffer** - Service workers are not cross-origin isolated (no COOP/COEP headers),
   so SharedArrayBuffer is unavailable. The standard ONNX WASM loader requires this for
   multi-threading.

### Workarounds

**Service Worker Polyfills** - `utils/inference/serviceWorkerPolyfills.ts` must be imported
**before** any ONNX Runtime imports. This patches `window` and `XMLHttpRequest`.

**WebGPU Bundle** - We use `ort.webgpu.bundle.min.mjs` which has the WASM glue code inlined,
avoiding dynamic `import()` for the JavaScript module.

**Asyncify WASM Preload** - We manually preload the asyncify WASM variant which uses async/await
patterns instead of SharedArrayBuffer:

```typescript
const WASM_PATH = '/ort/ort-wasm-simd-threaded.asyncify.wasm';
const wasmBinary = await fetch(WASM_PATH).then(r => r.arrayBuffer());
ort.env.wasm.wasmBinary = wasmBinary;
```

**Single-Threaded Configuration**:

```typescript
ort.env.wasm.numThreads = 1; // No Web Workers in service workers
ort.env.wasm.proxy = false; // Direct execution, no worker proxy
```

### Backend Selection

WebGPU is preferred whenever the browser exposes the WebGPU API (`navigator.gpu`), with WASM as the
fallback. The decision is made at runtime, so a single build covers all platforms:

- **Chrome / Chromium**: WebGPU first, WASM fallback
- **Firefox desktop (141+)**: WebGPU first (with the queue-poking workaround), WASM fallback
- **Firefox Android and other browsers without WebGPU**: WASM (no `navigator.gpu`)
- **WebGPU session creation failure** (blocklisted GPU, driver issues): automatic WASM fallback

### WASM Files

Copied automatically from `node_modules/onnxruntime-web/dist/` to `ort/` in the build output via the
`build:publicAssets` hook in `modules/inference-runtime.ts`:

```
ort/
├── ort-wasm-simd-threaded.asyncify.mjs   # Asyncify JS glue
├── ort-wasm-simd-threaded.asyncify.wasm  # Asyncify WASM binary (preloaded at runtime)
├── ort-wasm-simd-threaded.mjs            # Standard JS glue
└── ort-wasm-simd-threaded.wasm           # Standard WASM binary
```

### Firefox Bug: 100ms GPU Device Polling

Firefox polls WebGPU from a 100ms timer instead of when work completes, so the `mapAsync` readback
ending every `session.run` stalls ~100ms regardless of model size. Workaround
(`utils/inference/runtimes/onnx/webgpuQueuePoker.ts`, Firefox+WebGPU only): poke the queue with
empty command buffers while a run is pending, which drains the readback in a few ms.

Open upstream at [Bugzilla 1870699](https://bugzilla.mozilla.org/show_bug.cgi?id=1870699). Once a
Firefox release fixes it (plain `webgpu` matches `webgpu-poke-t` under `pnpm bench`), delete the
poker and its branch in `runSession()`.

### Known Warnings

- **"powerPreference ignored"** - Chrome bug on Windows (crbug.com/369219127). Doesn't affect
  functionality.

## Model Discovery System

Models are discovered dynamically at runtime from `metadata.yaml` files. This allows adding new
models without code changes.

### Adding a New Model

1. Create a directory under `public/models/` with naming convention: `{name}-y-{task}-{size}-{date}`
   (e.g. `afeef-y26-sem-320-20260610`)
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
| sem-i320 | `public/models/afeef-y26-sem-320-20260610` | 320×320    | 320×320     | 4       | semantic |
| sem-i448 | `public/models/afeef-y26-sem-448-20260610` | 448×448    | 448×448     | 4       | semantic |
| sem-i640 | `public/models/afeef-y26-sem-640-20260610` | 640×640    | 640×640     | 4       | semantic |

### Auto Model Policy

`sem-i320` is the baseline default and remains the default for non-WebGPU backends. In auto mode,
WebGPU sessions start at `sem-i448` as the balanced default (a head start, since each adaptive step
is rate-limited) because it captures most of the detection improvement over 320 at much less cost
than 640.

The auto switcher is driven by a **single signal**: p75 inference latency over the latest cached
predictions. It steps one model up or down per evaluation, with a hysteresis band to avoid
oscillation. It evaluates at most once per hour after 100 samples, with a six-hour cooldown after a
switch:

- A single target `THRESHOLD_INFERENCE_MS` (40ms) with a `THRESHOLD_TOLERANCE_MS` (10ms) deadband.
- **Upgrade** one size when p75 inference latency is below target − tolerance (30ms).
- **Downgrade** one size when p75 inference latency is above target + tolerance (50ms).
- Within the 30–50ms band the model holds steady.
- `sem-i640` is WebGPU-only — on WASM it is ~247ms, so the switcher never selects it without WebGPU.

On WebGPU the smaller sizes run under the 30ms upgrade point, so a capable GPU climbs until a model
lands inside the 30–50ms band (`sem-i640` at ~36ms). On WASM `sem-i320` already exceeds the upgrade
point (~58ms), so non-WebGPU sessions naturally settle at the baseline without any backend rule.

### Browser Performance (79 images)

Measured with the 20260607 exports; timings are size-dependent and remain representative, but
detection counts may differ slightly with the 20260610 weights.

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
~90-100ms above is the [polling bug](#firefox-bug-100ms-gpu-device-polling). Cold start still incurs
a ~6.7s shader compilation penalty (Firefox has no pipeline cache).

### Standalone Harness Results (Playwright, NVIDIA Ampere, June 2026)

Measured with `pnpm bench` (see `scripts/benchmark/README.md`) - same machine, Chromium vs Firefox,
mean `session.run` latency:

| Size | Chromium WebGPU | Firefox WebGPU | Firefox WebGPU + queue poke |
| ---- | --------------- | -------------- | --------------------------- |
| 320  | 12.0ms (83/s)   | 100.3ms (10/s) | 27.3ms (37/s)               |
| 448  | 13.6ms (74/s)   | 100.3ms (10/s) | 29.6ms (34/s)               |
| 640  | 17.4ms (57/s)   | 100.3ms (10/s) | 37.2ms (27/s)               |

Other options benchmarked on Firefox (graph capture, `gpu-buffer` output location, JSEP bundle, JSPI
bundle, NCHW layout) all stayed pinned at ~100ms - the poll tick dominates everything, so only queue
poking helps. On Chromium, graph capture and the JSPI bundle each shave ~2-3ms off the ~12ms
baseline; not worth the GPU-tensor I/O complexity at this latency. JSPI is not available in stable
Firefox. Concurrent `session.run` calls hang the asyncify bundle - queue concurrency must stay at 1.

## Architecture

- **Model**: YOLO26n-sem (Ultralytics)
- **Task**: Semantic segmentation
- **Format**: ONNX
- **Input Size**: 320×320 baseline; 448×448 / 640×640 available through model switching
- **Runtime**: ONNX Runtime Web (WebGPU with WASM fallback)

## Input Specification

- **Shape**: `[1, 3, H, W]` (NCHW format, where `H×W` is the active model input size)
- **Type**: `float32`
- **Normalization**: 0-1 range (pixel / 255)
- **Letterbox padding**: Gray (114, 114, 114)

## Output Specification

Single output tensor — per-pixel class logits:

| Tensor    | Shape          | Description                                   |
| --------- | -------------- | --------------------------------------------- |
| `output0` | `[1, 4, H, W]` | Per-pixel logits for each class (NCHW layout) |

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
output_shape: # Default: imgsz / stride
  - 320
  - 320
input_name: images # Default: 'images'
```

## Files

- `best.onnx` - ONNX model file
- `metadata.yaml` - Model metadata (classes, configuration)
