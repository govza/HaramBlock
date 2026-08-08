import { getAvailableModels, getBackend, getCurrentModelId, switchModel } from '@inference-runtime';

import { getLatencySnapshot, type LatencySnapshot } from '@/utils/inference/shared/latencyTracker';
import { getModelSettings, setModelSettings, type ModelPreference } from '@/utils/modelSettings';

export class ModelService {
  private onModelSwitch?: () => void;

  setOnModelSwitch(callback: () => void): void {
    this.onModelSwitch = callback;
  }

  async getAvailableModels(timeoutMs = 2000, pollMs = 100): Promise<{ id: string; name: string; inputSize: number }[]> {
    const start = Date.now();

    return new Promise(resolve => {
      const check = () => {
        const models = getAvailableModels();

        if (Array.isArray(models) && models.length > 0) {
          resolve(models);
          return;
        }

        if (Date.now() - start >= timeoutMs) {
          resolve(models);
          return;
        }

        setTimeout(check, pollMs);
      };

      check();
    });
  }

  // For background-internal callers after model discovery (e.g. AutoModelService).
  getAvailableModelsSync(): { id: string; name: string; inputSize: number }[] {
    return getAvailableModels();
  }

  getCurrentModelId(): string {
    return getCurrentModelId();
  }

  getInferenceLatency(): LatencySnapshot | null {
    return getLatencySnapshot();
  }

  /** 'unknown' until the model finishes loading; callers treat it as the conservative tier. */
  getInferenceBackend(): 'webgpu' | 'wasm' | 'unknown' {
    const backend = getBackend();
    return backend === 'webgpu' || backend === 'wasm' ? backend : 'unknown';
  }

  async getModelPreference(): Promise<ModelPreference> {
    return (await getModelSettings()).preference ?? 'auto';
  }

  async switchModel(modelId: string): Promise<void> {
    await switchModel(modelId);
    this.onModelSwitch?.();
  }

  async setModelPreference(preference: ModelPreference): Promise<void> {
    // 'auto' only persists the mode - AutoModelService reacts to the settings change, reseeds at
    // the backend default and applies the switch itself (queue-idle aware).
    if (preference !== 'auto') {
      await this.switchModel(preference);
    }
    await setModelSettings({ preference });
  }
}
