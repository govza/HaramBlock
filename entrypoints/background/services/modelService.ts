import { getAvailableModels, getCurrentModelId, switchModel } from '@inference-runtime';

import { setModelSettings, type ModelPreference } from '@/utils/modelSettings';

export class ModelService {
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

  getCurrentModelId(): string {
    return getCurrentModelId();
  }

  async switchModel(modelId: string): Promise<void> {
    await switchModel(modelId);
  }

  async setModelPreference(modelId: ModelPreference): Promise<void> {
    await switchModel(modelId);
    await setModelSettings({ preference: modelId });
  }
}
