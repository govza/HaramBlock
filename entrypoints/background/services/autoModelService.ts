import { getAvailableModels, getCurrentModelId, switchModel } from '@inference-runtime';

import { ImageCacheRepository } from '@/utils/db/imageCacheRepository';
import { logger } from '@/utils/logger';
import { getModelSettings, onModelSettingsChange } from '@/utils/modelSettings';

const IS_CHROME = import.meta.env.CHROME === true;

const UPGRADE_THRESHOLD = IS_CHROME ? 70 : 100;
const DOWNGRADE_THRESHOLD = IS_CHROME ? 120 : 180;
const MIN_SAMPLES = 10;
const COOLDOWN_MS = 30_000;
const DEBOUNCE_MS = 5_000;

const log = logger.withTag('autoModel');

function calculateMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const left = sorted[mid - 1];
    const right = sorted[mid];
    return left !== undefined && right !== undefined ? (left + right) / 2 : 0;
  }
  return sorted[mid] ?? 0;
}

export class AutoModelService {
  private lastSwitchTime = 0;
  private lastCheckTime = 0;
  private autoModeEnabled = false;
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
      }
    });

    log.debug(
      `Initialized, auto: ${this.autoModeEnabled}, thresholds: <${UPGRADE_THRESHOLD}ms / >${DOWNGRADE_THRESHOLD}ms`,
    );
  }

  async evaluate(): Promise<void> {
    if (!this.autoModeEnabled) return;

    const now = Date.now();
    if (now - this.lastCheckTime < DEBOUNCE_MS) return;
    if (now - this.lastSwitchTime < COOLDOWN_MS) return;

    this.lastCheckTime = now;

    const predictions = await this.imageCacheRepository.findAllValid();
    if (predictions.length < MIN_SAMPLES) return;

    const inferenceTimes = predictions.map(p => p.processingTime.inferenceTime);
    const median = calculateMedian(inferenceTimes);

    const currentModelId = getCurrentModelId();
    const currentIndex = this.modelsSortedBySize.indexOf(currentModelId);

    if (currentIndex === -1) {
      log.warn(`Current model ${currentModelId} not in sorted list`);
      return;
    }

    const canUpgrade = currentIndex < this.modelsSortedBySize.length - 1;
    const canDowngrade = currentIndex > 0;

    if (median < UPGRADE_THRESHOLD && canUpgrade) {
      const nextModel = this.modelsSortedBySize[currentIndex + 1];
      if (nextModel) {
        log.info(
          `Upgrading: ${currentModelId} → ${nextModel} (median: ${Math.round(median)}ms < ${UPGRADE_THRESHOLD}ms, samples: ${predictions.length})`,
        );
        this.lastSwitchTime = now;
        await switchModel(nextModel);
      }
    } else if (median > DOWNGRADE_THRESHOLD && canDowngrade) {
      const prevModel = this.modelsSortedBySize[currentIndex - 1];
      if (prevModel) {
        log.info(
          `Downgrading: ${currentModelId} → ${prevModel} (median: ${Math.round(median)}ms > ${DOWNGRADE_THRESHOLD}ms, samples: ${predictions.length})`,
        );
        this.lastSwitchTime = now;
        await switchModel(prevModel);
      }
    }
  }

  getEffectiveModelId(): string {
    return getCurrentModelId();
  }

  isAutoMode(): boolean {
    return this.autoModeEnabled;
  }

  cleanup(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}
