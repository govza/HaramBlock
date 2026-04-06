# YOLO11n-Seg Instance Segmentation Model

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

Chrome's WebGPU is fast (~42ms inference), Firefox's is slow (~410ms). We prefer:

- **Chrome**: WebGPU first, WASM fallback
- **Firefox**: WASM first, WebGPU fallback

### WASM Files

```
public/ort/
├── ort-wasm-simd-threaded.asyncify.mjs   # Asyncify JS glue (not used directly)
├── ort-wasm-simd-threaded.asyncify.wasm  # Asyncify WASM binary (preloaded)
├── ort-wasm-simd-threaded.mjs            # Standard JS glue (not used)
└── ort-wasm-simd-threaded.wasm           # Standard WASM (not used)
```

### Known Warnings

- **"Unknown CPU vendor"** - Harmless. ONNX Runtime tries CPUID detection which doesn't work in
  WASM. Falls back to generic code paths.
- **"powerPreference ignored"** - Chrome bug on Windows (crbug.com/369219127). Doesn't affect
  functionality.

## Model Discovery System

Models are discovered dynamically at runtime from `metadata.yaml` files. This allows adding new
models without code changes.

### Adding a New Model

1. Create a directory under `public/models/` with naming convention:
   `{name}-y-{size}-{classes}-{date}`
   - Example: `public/models/afeef-y-640-82-20250124/`
2. Add the ONNX model file as `best.onnx`
3. Add a `metadata.yaml` with required fields (see below)
4. Add the path to `MODEL_PATHS` array in `utils/inference/shared/modelRegistry.ts`

### Directory Contract

Each model directory should contain:

```
public/models/{name}-y-{size}-{classes}-{date}/
├── best.onnx                 # ONNX model
└── metadata.yaml             # Model metadata
```

### Required Metadata Fields

```yaml
id: i416 # Unique model identifier
name: YOLO26n 416×416 (3 classes) # Human-readable display name
imgsz: # Input dimensions
  - 416
  - 416
names: # Class mapping
  0: zfa
  1: zma
  2: zsa
```

### Model Loader API

```typescript
// Discover all available models (called automatically on init)
await discoverModels();

// Initialize with specific model
await initializeModel('i416');

// Get current model ID
const id = getCurrentModelId();

// List all discovered models
const models = getAvailableModels();
```

## Auto Model Selection

The extension can automatically switch between models based on inference performance. This adapts to
the user's hardware capabilities.

### User Preferences

Users can choose:

- **Auto** - Extension monitors performance and switches models automatically
- **Specific model** - User manually selects a model (stored and restored on startup)

Preference is stored in `browser.storage.local` under `modelSettings`.

### Auto Selection Algorithm

When `preference === 'auto'`, the `AutoModelService` evaluates performance:

| Parameter             | Value   | Description                                    |
| --------------------- | ------- | ---------------------------------------------- |
| `REQUIRED_SAMPLES`    | 100     | Samples needed before making decisions         |
| `DEBOUNCE_MS`         | 1 hour  | Minimum time between evaluations               |
| `COOLDOWN_MS`         | 6 hours | Minimum time after a switch before re-evaluate |
| `UPGRADE_THRESHOLD`   | 70ms    | Median below this triggers upgrade (Chrome)    |
| `DOWNGRADE_THRESHOLD` | 120ms   | Median above this triggers downgrade (Chrome)  |

**Decision flow:**

1. Collect last 100 inference times from cache
2. Calculate median inference time
3. If median < 70ms and larger model available → upgrade
4. If median > 120ms and smaller model available → downgrade
5. After switch, wait 6 hours before next evaluation

Models are sorted by input size, so "upgrade" means switching to a larger, more accurate model,
while "downgrade" means switching to a smaller, faster model.

## Available Models

| ID   | Directory                              | Input Size | Classes |
| ---- | -------------------------------------- | ---------- | ------- |
| i416 | `public/models/afeef-y26-416-20260315` | 416×416    | 3       |

## Model Location

- `public/models/{model-dir}/best.onnx`

## Architecture

- **Model**: YOLO11n-seg (Ultralytics)
- **Task**: Instance segmentation
- **Format**: ONNX with NMS
- **Input Size**: 416x416
- **Runtime**: ONNX Runtime Web (WebGPU with WASM fallback)

## Input Specification

- **Shape**: `[1, 3, 416, 416]` (NCHW format)
- **Type**: `float32`
- **Normalization**: 0-1 range (pixel / 255)
- **Letterbox padding**: Gray (114, 114, 114)

## Output Specification

Two output tensors (with NMS enabled):

| Tensor    | Shape               | Description                                        |
| --------- | ------------------- | -------------------------------------------------- |
| `output0` | `[1, N, 38]`        | Detections: [x1, y1, x2, y2, conf, cls, coeffs*32] |
| `output1` | `[1, 32, 104, 104]` | Prototype masks for mask computation               |

### Target Classes

| Index | Class | Description  |
| ----- | ----- | ------------ |
| 0     | zfa   | Female awrah |
| 1     | zma   | Male awrah   |
| 2     | zsa   | Shared awrah |

### Postprocessing

```typescript
// 1. Extract detection data from output0
const x1 = output0[i * 38];     // Pixel coordinates
const y1 = output0[i * 38 + 1];
const x2 = output0[i * 38 + 2];
const y2 = output0[i * 38 + 3];
const conf = output0[i * 38 + 4];  // Confidence score
const cls = output0[i * 38 + 5];   // Class ID

// 2. Extract mask coefficients (32 values)
const coeffs = output0.slice(i * 38 + 6, i * 38 + 38);

// 3. Compute instance mask: sigmoid(coeffs @ prototypes)
for (y, x in mask_grid):
  mask[y][x] = sigmoid(sum(coeffs[c] * prototypes[c, y, x]))

// 4. Apply letterbox inverse transform to original image coordinates
// 5. Binarize masks (threshold > 0.5)
// 6. Encode masks as RLE
```

### Mask RLE Encoding

Masks are stored using Run-Length Encoding (RLE) for efficient caching:

```typescript
interface IRLEMask {
  width: number; // Mask dimensions (prototype resolution)
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

- Sparse masks (small detected regions) compress well: `[25000, 50, 550]` for a 160×160 mask
- Empty masks are essentially free: `{ runs: [] }`
- Self-contained format with embedded dimensions for portability

## Metadata Configuration

The `metadata.yaml` file contains model-specific configuration:

```yaml
# Required fields
id: i416 # Unique model identifier
name: YOLO26n 416×416 (3 classes) # Human-readable display name
imgsz:
  - 416
  - 416
names:
  0: zfa
  1: zma
  2: zsa

# Optional fields (with defaults)
description: Ultralytics YOLO26n-seg model
author: Ultralytics
stride: 32 # Default: 32
task: segment
batch: 1
args:
  nms: false
output_shape: # Default: imgsz / stride
  - 104
  - 104
input_name: images # Default: 'images'
output_names:
  masks: output1 # Default: 'output1'
```

## Files

- `best.onnx` - ONNX model file with built-in NMS
- `metadata.yaml` - Model metadata (classes, configuration)
