import path from 'node:path';

import { addAlias, addViteConfig, defineWxtModule } from 'wxt/modules';

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

    wxt.logger.info('Inference runtime: ONNX');
  },
});
