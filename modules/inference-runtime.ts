import path from 'node:path';

import { addAlias, addViteConfig, defineWxtModule } from 'wxt/modules';

export default defineWxtModule({
  name: 'inference-runtime',
  setup(wxt) {
    const isFirefox = wxt.config.browser === 'firefox';

    // Select runtime based on target browser
    // Use relative path from project root (addAlias doesn't resolve @/ prefix)
    const runtimePath = isFirefox ? 'utils/inference/runtimes/tfjs' : 'utils/inference/runtimes/onnx';
    addAlias(wxt, '@inference-runtime', runtimePath);

    // ONNX-specific aliases for Chrome builds (force WebGPU bundle, no dynamic imports)
    if (!isFirefox) {
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
    }

    wxt.logger.info(`Inference runtime: ${isFirefox ? 'TensorFlow.js' : 'ONNX'}`);
  },
});
