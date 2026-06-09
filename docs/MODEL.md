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

Chrome's WebGPU is fast (~42ms inference), Firefox's is slow (~410ms). We prefer:

- **Chrome**: WebGPU first, WASM fallback
- **Firefox**: WASM first, WebGPU fallback

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

## Architecture

- **Model**: YOLO26n-sem (Ultralytics)
- **Task**: Semantic segmentation
- **Format**: ONNX
- **Input Size**: 320×320
- **Runtime**: ONNX Runtime Web (WebGPU with WASM fallback)

## Input Specification

- **Shape**: `[1, 3, 320, 320]` (NCHW format)
- **Type**: `float32`
- **Normalization**: 0-1 range (pixel / 255)
- **Letterbox padding**: Gray (114, 114, 114)

## Output Specification

Single output tensor — per-pixel class logits:

| Tensor    | Shape              | Description                                   |
| --------- | ------------------ | --------------------------------------------- |
| `output0` | `[1, 4, 320, 320]` | Per-pixel logits for each class (NCHW layout) |

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
