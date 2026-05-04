import path from 'node:path';

import { addAlias, addViteConfig, defineWxtModule } from 'wxt/modules';

const ORT_WASM_FILES = [
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
];

export default defineWxtModule({
  name: 'inference-runtime',
  setup(wxt) {
    // ONNX runtime is the only supported runtime
    const runtimePath = 'utils/inference/runtimes/onnx';
    addAlias(wxt, '@inference-runtime', runtimePath);

    // ONNX-specific aliases (force WebGPU bundle, no dynamic imports)
    addViteConfig(wxt, () => ({
      resolve: {
        alias: {
          'onnxruntime-web/webgpu': path.resolve(
            wxt.config.root,
            'node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs',
          ),
          'onnxruntime-web': path.resolve(
            wxt.config.root,
            'node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs',
          ),
        },
      },
      optimizeDeps: {
        exclude: ['onnxruntime-web'],
      },
    }));

    // Copy ONNX Runtime WASM files to build output (keeps them in sync with the installed version)
    wxt.hook('build:publicAssets', (_, assets) => {
      const distDir = path.resolve(wxt.config.root, 'node_modules/onnxruntime-web/dist');

      for (const file of ORT_WASM_FILES) {
        assets.push({
          relativeDest: `ort/${file}`,
          absoluteSrc: path.join(distDir, file),
        });
      }

      wxt.logger.info(`Copied ${ORT_WASM_FILES.length} ONNX Runtime WASM files to ort/`);
    });

    wxt.logger.info('Inference runtime: ONNX');
  },
});
