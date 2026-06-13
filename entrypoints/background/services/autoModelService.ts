import { getAvailableModels, getBackend, getCurrentModelId, switchModel } from '@inference-runtime';

import { ImageCacheRepository } from '@/utils/db/imageCacheRepository';
import { logger } from '@/utils/logger';
import { getModelSettings, onModelSettingsChange, setModelSettings } from '@/utils/modelSettings';

export const BASELINE_MODEL_ID = 'sem-i320';
export const BALANCED_MODEL_ID = 'sem-i448';
const MAX_QUALITY_MODEL_ID = 'sem-i640';

const WEBGPU_BACKEND = 'webgpu';

// Target p75 inference latency; switch only when latency strays past the tolerance band around it.
const THRESHOLD_INFERENCE_MS = 40;
const THRESHOLD_TOLERANCE_MS = 10;
const LATENCY_PERCENTILE = 75;

const REQUIRED_SAMPLES = 100;
const DEBOUNCE_MS = 60 * 60 * 1000; // 1 hour
const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

const log = logger.withTag('autoModel');

function calculatePercentile(values: number[], percentile: number): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))] ?? 0;
}

export class AutoModelService {
  private lastSwitchTime = 0;
  private lastCheckTime = 0;
  private autoModeEnabled = false;
  private isSwitching = false;
  private unsubscribe: (() => void) | null = null;
  private modelsSortedBySize: string[] = [];
  private imageCacheRepository = new ImageCacheRepository();

  async initialize(): Promise<void> {
    const models = getAvailableModels();

    this.modelsSortedBySize = models
      .slice()
      .sort((a, b) => a.inputSize - b.inputSize)
      .map(m => m.id);

    const settings = await getModelSettings();
    this.autoModeEnabled = settings.preference === 'auto';

    this.unsubscribe = onModelSettingsChange(newSettings => {
      const wasEnabled = this.autoModeEnabled;
      this.autoModeEnabled = newSettings.preference === 'auto';

      if (!wasEnabled && this.autoModeEnabled) {
        log.info('Auto mode re-enabled, restarting auto session at balanced default');
        this.lastSwitchTime = 0;
        this.lastCheckTime = 0;
        void this.applyAutoModel(true);
      }
    });

    log.debug(
      `Initialized, auto: ${this.autoModeEnabled}, p${LATENCY_PERCENTILE} inference target ${THRESHOLD_INFERENCE_MS}±${THRESHOLD_TOLERANCE_MS}ms`,
    );

    await this.applyAutoModel(false);
  }

  async evaluate(): Promise<void> {
    if (!this.autoModeEnabled || this.isSwitching) return;

    const now = Date.now();
    if (now - this.lastCheckTime < DEBOUNCE_MS) return;
    if (now - this.lastSwitchTime < COOLDOWN_MS) return;

    const predictions = await this.imageCacheRepository.findRecent(REQUIRED_SAMPLES);
    if (predictions.length < REQUIRED_SAMPLES) return;

    this.lastCheckTime = now;

    const inferenceTimes = predictions.map(p => p.processingTime.inferenceTime);
    const inferenceLatency = calculatePercentile(inferenceTimes, LATENCY_PERCENTILE);

    const currentModelId = getCurrentModelId();
    const currentIndex = this.modelsSortedBySize.indexOf(currentModelId);

    if (currentIndex === -1) {
      log.warn(`Current model ${currentModelId} not in sorted list`);
      return;
    }

    const upgradeBelow = THRESHOLD_INFERENCE_MS - THRESHOLD_TOLERANCE_MS;
    const downgradeAbove = THRESHOLD_INFERENCE_MS + THRESHOLD_TOLERANCE_MS;
    const stat = `p${LATENCY_PERCENTILE} inference: ${Math.round(inferenceLatency)}ms, samples: ${predictions.length}`;

    if (inferenceLatency < upgradeBelow && currentIndex < this.modelsSortedBySize.length - 1) {
      const nextModel = this.modelsSortedBySize[currentIndex + 1];
      if (nextModel && this.isBackendCapableOf(nextModel)) {
        log.info(`Upgrading: ${currentModelId} → ${nextModel} (${stat} < ${upgradeBelow}ms)`);
        if (await this.runSwitch(nextModel)) this.lastSwitchTime = now;
      }
    } else if (inferenceLatency > downgradeAbove && currentIndex > 0) {
      const prevModel = this.modelsSortedBySize[currentIndex - 1];
      if (prevModel) {
        log.info(`Downgrading: ${currentModelId} → ${prevModel} (${stat} > ${downgradeAbove}ms)`);
        if (await this.runSwitch(prevModel)) this.lastSwitchTime = now;
      }
    } else {
      log.debug(`Keeping ${currentModelId} (${stat}, target band ${upgradeBelow}-${downgradeAbove}ms)`);
    }
  }

  // sem-i640 is unusably slow without WebGPU (~247ms on WASM), so keep it WebGPU-only.
  private isBackendCapableOf(modelId: string): boolean {
    return modelId !== MAX_QUALITY_MODEL_ID || getBackend() === WEBGPU_BACKEND;
  }

  private async runSwitch(modelId: string): Promise<boolean> {
    if (this.isSwitching) return false;
    this.isSwitching = true;
    try {
      await switchModel(modelId);
      await setModelSettings({ autoSelectedModelId: modelId });
      return true;
    } finally {
      this.isSwitching = false;
    }
  }

  getEffectiveModelId(): string {
    return getCurrentModelId();
  }

  isAutoMode(): boolean {
    return this.autoModeEnabled;
  }

  // Startup (`reseed=false`) keeps a remembered selection so restarts are stable; re-entering auto
  // from manual (`reseed=true`) restarts the session at the backend's balanced default, so a stale
  // or stuck selection can't pin the model and manual→auto always lands on a sensible baseline.
  private async applyAutoModel(reseed: boolean): Promise<void> {
    if (!this.autoModeEnabled || this.modelsSortedBySize.length === 0) return;

    const backend = getBackend();
    const currentModelId = getCurrentModelId();
    const remembered = reseed ? undefined : (await getModelSettings()).autoSelectedModelId;
    const rememberedTarget = backend === WEBGPU_BACKEND && remembered === BASELINE_MODEL_ID ? undefined : remembered;

    // A remembered model unsupported on this backend (e.g. sem-i640 after WebGPU is lost) drops to
    // the backend default.
    const target =
      rememberedTarget && this.isBackendCapableOf(rememberedTarget)
        ? rememberedTarget
        : this.getDefaultModelIdForBackend(backend);
    if (!target) return;

    if (currentModelId !== target) {
      log.info(`Applying auto model on ${backend}${reseed ? ' (reset)' : ''}: ${currentModelId} → ${target}`);
      await this.runSwitch(target);
    } else if (reseed || remembered !== target) {
      // Already on the target, but the persisted selection may be stale - record the reset/self-heal.
      await setModelSettings({ autoSelectedModelId: target });
    }
  }

  private getDefaultModelIdForBackend(backend: string): string | undefined {
    if (backend === WEBGPU_BACKEND && this.modelsSortedBySize.includes(BALANCED_MODEL_ID)) {
      return BALANCED_MODEL_ID;
    }

    if (this.modelsSortedBySize.includes(BASELINE_MODEL_ID)) {
      return BASELINE_MODEL_ID;
    }

    return this.modelsSortedBySize[0];
  }

  cleanup(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}
