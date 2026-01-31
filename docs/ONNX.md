# ONNX Runtime Web in Service Workers

This document explains how we run ONNX Runtime Web in Chrome extension service workers, which have
significant limitations compared to regular web pages.

## The Problem

Service workers have two critical restrictions that break standard ONNX Runtime Web usage:

1. **No dynamic `import()`** - The HTML specification disallows dynamic imports in
   ServiceWorkerGlobalScope. ONNX Runtime internally uses `import()` to load its WASM loader module.

2. **No SharedArrayBuffer** - Service workers are not cross-origin isolated (no COOP/COEP headers),
   so SharedArrayBuffer is unavailable. The standard ONNX WASM loader requires this for
   multi-threading.

## The Solution

We use a combination of techniques to work around these limitations:

### 1. Service Worker Polyfills

`utils/inference/serviceWorkerPolyfills.ts` must be imported **before** any ONNX Runtime imports:

```typescript
// Polyfills MUST be imported first (before onnxruntime-web)
import '@/utils/inference/serviceWorkerPolyfills';
```

This patches:

- `window` - ONNX Runtime expects `window` to exist
- `XMLHttpRequest` - ONNX Runtime uses XHR internally, polyfilled with `fetch()`

### 2. WebGPU Bundle (Avoids Dynamic Import for JS)

We use `ort.webgpu.bundle.min.mjs` via Vite alias in `modules/inference-runtime.ts`:

```typescript
'onnxruntime-web': path.resolve(
  wxt.config.root,
  'node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs',
),
```

The **bundle** version has the WASM glue code inlined, avoiding dynamic `import()` for the
JavaScript module.

### 3. Asyncify WASM Preload (Avoids SharedArrayBuffer)

We manually preload the asyncify WASM variant in `utils/inference/runtimes/onnx/modelLoader.ts`:

```typescript
const WASM_PATH = '/ort/ort-wasm-simd-threaded.asyncify.wasm';

async function preloadWasmBinary(): Promise<ArrayBuffer> {
  // ... fetch and return ArrayBuffer
}

// Before creating session:
const wasmBinary = await preloadWasmBinary();
ort.env.wasm.wasmBinary = wasmBinary;
```

The **asyncify** variant:

- Uses async/await patterns instead of SharedArrayBuffer
- Works in non-cross-origin-isolated environments
- Designed specifically for this use case

### 4. Single-Threaded Configuration

```typescript
ort.env.wasm.numThreads = 1; // No Web Workers in service workers
ort.env.wasm.proxy = false; // Direct execution, no worker proxy
```

## File Structure

```
public/ort/
├── ort-wasm-simd-threaded.asyncify.mjs   # Asyncify JS glue (not used directly)
├── ort-wasm-simd-threaded.asyncify.wasm  # Asyncify WASM binary (preloaded)
├── ort-wasm-simd-threaded.mjs            # Standard JS glue (not used)
└── ort-wasm-simd-threaded.wasm           # Standard WASM (not used)
```

## Backend Selection

Chrome's WebGPU is fast (~42ms inference), Firefox's is slow (~410ms). We prefer:

- **Chrome**: WebGPU first, WASM fallback
- **Firefox**: WASM first, WebGPU fallback

```typescript
const isFirefox = navigator.userAgent.includes('Firefox');
const backends = isFirefox ? ['wasm', 'webgpu'] : ['webgpu', 'wasm'];
```

## Known Problems

### "Unknown CPU vendor" Error

```
[W:onnxruntime:Default, cpuid_info.cc:91 LogEarlyWarning] Unknown CPU vendor. cpuinfo_vendor value: 0
```

This is **harmless**. ONNX Runtime tries to detect CPU features via CPUID, which doesn't work in
WASM. It falls back to generic code paths and continues working.

### "powerPreference ignored" Warning

```
The powerPreference option is currently ignored when calling requestAdapter() on Windows.
```

This is a Chrome bug on Windows (crbug.com/369219127). WebGPU ignores the power preference hint.
Doesn't affect functionality.

## References

- [GitHub Issue #20876](https://github.com/microsoft/onnxruntime/issues/20876) - WebGPU and WASM in
  Service Workers
- [W3C ServiceWorker Issue #1356](https://github.com/w3c/ServiceWorker/issues/1356) - Dynamic import
  restriction
- [ONNX Runtime Web Deployment](https://onnxruntime.ai/docs/tutorials/web/deploy.html)
