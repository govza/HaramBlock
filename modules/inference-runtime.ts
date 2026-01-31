import path from 'node:path';

import { addAlias, addViteConfig, defineWxtModule } from 'wxt/modules';

export default defineWxtModule({
  name: 'inference-runtime',
  setup(wxt) {
    // Environment variable override (ONNX is default for all browsers)
    const envOverride = process.env.INFERENCE_RUNTIME?.toLowerCase();
    const hasValidOverride = envOverride === 'tfjs' || envOverride === 'onnx';

    // Final runtime selection (ONNX default, TensorFlow.js only if explicitly requested)
    const useOnnx = hasValidOverride ? envOverride === 'onnx' : true;
    const useTfjs = !useOnnx;

    // Select runtime path (relative from project root, addAlias doesn't resolve @/ prefix)
    const runtimePath = useTfjs ? 'utils/inference/runtimes/tfjs' : 'utils/inference/runtimes/onnx';
    addAlias(wxt, '@inference-runtime', runtimePath);

    // ONNX-specific aliases (force WebGPU bundle, no dynamic imports)
    if (useOnnx) {
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

    // Log with override indicator
    const runtimeName = useTfjs ? 'TensorFlow.js' : 'ONNX';
    const isOverridden = hasValidOverride && envOverride !== browserDefault;
    wxt.logger.info(`Inference runtime: ${runtimeName}${isOverridden ? ' (overridden)' : ''}`);
  },
});
