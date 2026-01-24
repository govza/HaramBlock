# YOLO11n-Seg Instance Segmentation Model

## Dual Runtime Architecture

The extension supports two inference runtimes selected at build time:

- **Chrome**: ONNX Runtime Web (WebGPU/WASM backend)
- **Firefox**: TensorFlow.js (WebGL backend)

The runtime is selected automatically via the WXT module `modules/inference-runtime.ts`.

## Model Discovery System

Models are discovered dynamically at runtime from `metadata.yaml` files. This allows adding new
models without code changes.

### Adding a New Model

1. Create a directory under `public/models/` with naming convention:
   `{name}-y-{size}-{classes}-{date}`
   - Example: `public/models/afeef-y-640-82-20250124/`
2. Add the ONNX model file as `best.onnx`
3. Add the TensorFlow.js model in `best_web_model/` subdirectory (`model.json` + weight shards)
4. Add a `metadata.yaml` with required fields (see below)
5. Add the path to `MODEL_PATHS` array in both:
   - `utils/inference/runtimes/onnx/modelLoader.ts` (for Chrome)
   - `utils/inference/runtimes/tfjs/modelLoader.ts` (for Firefox)

### Directory Contract

Each model directory should contain:

```
public/models/{name}-y-{size}-{classes}-{date}/
├── best.onnx                 # ONNX model (Chrome)
├── best_web_model/           # TensorFlow.js model (Firefox)
│   ├── model.json
│   └── group1-shard*.bin
└── metadata.yaml             # Shared metadata
```

### Required Metadata Fields

```yaml
id: y320 # Unique model identifier
name: YOLO11n 320×320 (3 classes) # Human-readable display name
imgsz: # Input dimensions
  - 320
  - 320
names: # Class mapping
  0: person
  1: zfa
  2: zma
```

### Model Loader API

```typescript
// Discover all available models (called automatically on init)
await discoverModels();

// Initialize with specific model
await initializeModel('y320');

// Switch between models at runtime
await switchModel('y640');

// Get current model ID
const id = getCurrentModelId();

// List all discovered models
const models = getAvailableModels();
```

## Available Models

| ID   | Directory                              | Input Size | Classes | Runtimes    |
| ---- | -------------------------------------- | ---------- | ------- | ----------- |
| y320 | `public/models/afeef-y-320-3-20250124` | 320×320    | 3       | ONNX        |
| y640 | `public/models/aeef-y-640-82-20250124` | 640×640    | 82      | ONNX + TFJS |

## Model Location

- ONNX: `public/models/{model-dir}/best.onnx`
- TensorFlow.js: `public/models/{model-dir}/best_web_model/model.json`

## Architecture

- **Model**: YOLO11n-seg (Ultralytics)
- **Task**: Instance segmentation
- **Format**: ONNX with NMS (Chrome) / TensorFlow.js GraphModel (Firefox)
- **Input Size**: 320x320 or 640x640
- **Runtime**:
  - Chrome: ONNX Runtime Web (WebGPU with WASM fallback)
  - Firefox: TensorFlow.js (WebGL with CPU fallback)

## Input Specification

- **Shape**: `[1, 3, 320, 320]` (NCHW format)
- **Type**: `float32`
- **Normalization**: 0-1 range (pixel / 255)
- **Letterbox padding**: Gray (114, 114, 114)

## Output Specification

Two output tensors (with NMS enabled):

| Tensor    | Shape             | Description                                        |
| --------- | ----------------- | -------------------------------------------------- |
| `output0` | `[1, N, 38]`      | Detections: [x1, y1, x2, y2, conf, cls, coeffs*32] |
| `output1` | `[1, 32, 80, 80]` | Prototype masks for mask computation               |

### Target Classes

| Index | Class  | Description  |
| ----- | ------ | ------------ |
| 0     | person | Person       |
| 1     | zfa    | Female awrah |
| 2     | zma    | Male awrah   |

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
id: y320 # Unique model identifier
name: YOLO11n 320×320 # Human-readable display name
imgsz:
  - 320
  - 320
names:
  0: person
  1: zfa
  2: zma

# Optional fields (with defaults)
description: Ultralytics YOLO11n-seg model
author: Ultralytics
stride: 32 # Default: 32
task: segment
batch: 1
args:
  nms: true
output_shape: # Default: imgsz / stride
  - 80
  - 80
input_name: images # Default: 'images'
output_names:
  masks: output1 # Default: 'output1'
```

## Files

- `best.onnx` - ONNX model file with built-in NMS
- `metadata.yaml` - Model metadata (classes, configuration)
