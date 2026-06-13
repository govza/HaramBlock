import { getAvailableModels, getBackend, getCurrentModelId, switchModel } from '@inference-runtime';

import { ImageCacheRepository } from '@/utils/db/imageCacheRepository';
import { logger } from '@/utils/logger';
import { getModelSettings, onModelSettingsChange, setModelSettings } from '@/utils/modelSettings';

const BASELINE_MODEL_ID = 'sem-i320';
const BALANCED_MODEL_ID = 'sem-i448';
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
        log.info('Auto mode enabled, resetting timers');
        this.lastSwitchTime = 0;
        this.lastCheckTime = 0;
        void this.applyStartupModel();
      }
    });

    log.debug(
      `Initialized, auto: ${this.autoModeEnabled}, p${LATENCY_PERCENTILE} inference target ${THRESHOLD_INFERENCE_MS}±${THRESHOLD_TOLERANCE_MS}ms`,
    );

    await this.applyStartupModel();
  }

  async evaluate(): Promise<void> {
    if (!this.autoModeEnabled || this.isSwitching) return;

    const now = Date.now();
    if (now - this.lastCheckTime < DEBOUNCE_MS) return;
    if (now - this.lastSwitchTime < COOLDOWN_MS) return;

    this.lastCheckTime = now;

    const predictions = await this.imageCacheRepository.findRecent(REQUIRED_SAMPLES);
    if (predictions.length < REQUIRED_SAMPLES) return;

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

  private async applyStartupModel(): Promise<void> {
    if (!this.autoModeEnabled || this.modelsSortedBySize.length === 0) return;

    const backend = getBackend();
    const currentModelId = getCurrentModelId();

    // A restored model unsupported on this backend (e.g. sem-i640 after WebGPU is lost) drops to baseline.
    if (!this.isBackendCapableOf(currentModelId)) {
      const fallback = this.getDefaultModelIdForBackend(backend);
      if (fallback && fallback !== currentModelId) {
        log.info(`Restored ${currentModelId} unsupported on ${backend}, falling back to ${fallback}`);
        if (await this.runSwitch(fallback)) this.lastCheckTime = Date.now();
      }
      return;
    }

    // Trust a remembered selection; only seed a backend default on first run.
    const { autoSelectedModelId } = await getModelSettings();
    if (autoSelectedModelId) return;

    const target = this.getDefaultModelIdForBackend(backend);
    if (!target || currentModelId === target) return;

    log.info(`Seeding auto default for ${backend}: ${currentModelId} → ${target}`);
    if (await this.runSwitch(target)) this.lastCheckTime = Date.now();
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
