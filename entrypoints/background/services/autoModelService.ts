import { getBackend, getCurrentModelId } from '@inference-runtime';

import {
  decideModelSwitch,
  defaultModelIdForBackend,
  isAutoPreference,
  isBackendCapableOf,
  MAX_AUTO_SWITCHES_PER_SESSION,
  MEASUREMENT_TTL_MS,
  type ModelRung,
} from '@/entrypoints/background/services/autoModelDecision';
import {
  DOWNGRADE_ABOVE_MS,
  getLatencySnapshot,
  isLatencyWindowFull,
  onInferenceLatencySample,
  TARGET_P75_MS,
} from '@/utils/inference/shared/latencyTracker';
import {
  getModelSettings,
  onModelSettingsChange,
  updateAutoModelState,
  type AutoModelState,
} from '@/utils/modelSettings';
import { getLogger } from '@/utils/telemetry';

import type { ModelService } from '@/entrypoints/background/services/modelService';
import type { QueueService } from '@/entrypoints/background/services/queueService';

// Settled slow guard: once converged, only a sustained regression (two full windows over the
// downgrade line, at least this far apart) re-opens evaluation.
const SLOW_GUARD_MIN_GAP_MS = 10 * 60 * 1000;

const log = getLogger('autoModel');

export class AutoModelService {
  private autoEnabled = false;
  private settled = false;
  private isEvaluating = false;
  private sessionSwitchCount = 0;
  private slowStrikeAt = 0; // Timestamp of the first slow-guard strike (0 = none)
  private auto: AutoModelState = {};
  private pendingSwitch: { targetModelId: string; direction: string; reason: string } | null = null;
  private unsubscribers: Array<() => void> = [];

  constructor(
    private modelService: ModelService,
    private queueService: QueueService,
  ) {}

  /** Call after initializeInference resolves - models are discovered and the backend is known. */
  async initialize(): Promise<void> {
    const settings = await getModelSettings();
    this.autoEnabled = isAutoPreference(settings.preference);
    this.auto = settings.auto ?? {};

    this.unsubscribers.push(
      onModelSettingsChange(newSettings => {
        const wasEnabled = this.autoEnabled;
        this.autoEnabled = isAutoPreference(newSettings.preference);
        this.auto = newSettings.auto ?? {};

        if (!wasEnabled && this.autoEnabled) {
          void this.reseed('auto mode re-enabled');
        } else if (wasEnabled && !this.autoEnabled) {
          this.pendingSwitch = null;
        }
      }),
      onInferenceLatencySample(() => void this.evaluate()),
      this.queueService.onIdle(() => void this.applyPendingSwitch()),
    );

    if (this.autoEnabled) {
      await this.reconcileOnStartup();
    }

    log.debug('automodel.initialized', {
      auto: this.autoEnabled,
      settled: this.settled,
      targetP75Ms: TARGET_P75_MS,
      downgradeAboveMs: DOWNGRADE_ABOVE_MS,
    });
  }

  cleanup(): void {
    this.unsubscribers.forEach(unsubscribe => unsubscribe());
    this.unsubscribers = [];
  }

  private getRungs(): ModelRung[] {
    return this.modelService
      .getAvailableModelsSync()
      .slice()
      .sort((a, b) => a.inputSize - b.inputSize)
      .map(m => ({ id: m.id, inputSize: m.inputSize }));
  }

  /**
   * Bring persisted auto state and the loaded model in line at startup. index.ts already loads
   * auto.selectedModelId when it can, so this usually just revalidates; it reseeds when the state
   * was built on another backend, the selected model left the registry, or the settle expired.
   */
  private async reconcileOnStartup(): Promise<void> {
    const backend = getBackend();
    const rungs = this.getRungs();
    const selected = this.auto.selectedModelId;
    const now = Date.now();

    if (
      this.auto.backend !== backend ||
      !selected ||
      !rungs.some(r => r.id === selected) ||
      !isBackendCapableOf(selected, backend)
    ) {
      await this.reseed(this.auto.backend !== backend ? `backend changed to ${backend}` : 'no valid auto selection');
      return;
    }

    const settleFresh = this.auto.settledAt !== undefined && now - this.auto.settledAt <= MEASUREMENT_TTL_MS;
    this.settled = settleFresh;
    if (this.auto.settledAt !== undefined && !settleFresh) {
      log.info('automodel.settled_state_expired');
      await updateAutoModelState({ settledAt: undefined });
    }

    if (getCurrentModelId() !== selected) {
      this.requestSwitch(selected, 'restore', 'startup selection out of sync');
    }
  }

  /** Restart the auto session at the backend default. Measured latencies are kept - they describe
   *  the hardware, not the session - so a doomed re-climb is still vetoed. */
  private async reseed(cause: string): Promise<void> {
    const backend = getBackend();
    const rungs = this.getRungs();
    const target = defaultModelIdForBackend(backend, rungs);
    if (!target) return;

    this.settled = false;
    this.slowStrikeAt = 0;
    this.sessionSwitchCount = 0;

    // Measured latencies survive a same-backend reseed - they describe the hardware, not the
    // session or the decision policy.
    const keepMeasurements = this.auto.backend === backend;
    await updateAutoModelState({
      selectedModelId: target,
      backend,
      settledAt: undefined,
      lastSwitchAt: undefined,
      measured: keepMeasurements ? this.auto.measured : undefined,
    });

    log.info('automodel.reseeding', { cause, target, backend });
    if (getCurrentModelId() !== target) {
      this.requestSwitch(target, 'reseed', cause);
    }
  }

  /** Runs on every recorded latency sample; cheap until a decision is actually due. */
  private async evaluate(): Promise<void> {
    if (!this.autoEnabled || this.isEvaluating || this.pendingSwitch) return;
    if (this.sessionSwitchCount >= MAX_AUTO_SWITCHES_PER_SESSION) return;

    const snapshot = getLatencySnapshot();
    if (!snapshot) return;
    if (snapshot.modelId !== getCurrentModelId() || snapshot.backend !== getBackend()) return;

    this.isEvaluating = true;
    try {
      if (this.settled) {
        await this.runSlowGuard(snapshot.p75Ms);
        return;
      }

      const decision = decideModelSwitch({
        rungs: this.getRungs(),
        currentModelId: snapshot.modelId,
        backend: snapshot.backend,
        p75Ms: snapshot.p75Ms,
        sampleCount: snapshot.sampleCount,
        measured: this.auto.measured ?? {},
        lastSwitchAt: this.auto.lastSwitchAt,
        now: Date.now(),
      });

      if (decision.action === 'settle') {
        this.settled = true;
        await this.recordMeasurement(snapshot.modelId, snapshot.p75Ms);
        await updateAutoModelState({ settledAt: Date.now(), selectedModelId: snapshot.modelId });
        log.info('automodel.settled', { modelId: snapshot.modelId, reason: decision.reason });
      } else if (decision.action === 'switch') {
        await this.recordMeasurement(snapshot.modelId, snapshot.p75Ms);
        this.requestSwitch(decision.targetModelId, decision.direction, decision.reason);
      }
    } finally {
      this.isEvaluating = false;
    }
  }

  /** After settling, only a sustained regression - two full windows over the downgrade line at
   *  least SLOW_GUARD_MIN_GAP_MS apart - re-opens evaluation with a downgrade. */
  private async runSlowGuard(p75Ms: number): Promise<void> {
    if (p75Ms <= DOWNGRADE_ABOVE_MS) {
      this.slowStrikeAt = 0;
      return;
    }
    if (!isLatencyWindowFull()) return;

    const now = Date.now();
    if (this.slowStrikeAt === 0) {
      this.slowStrikeAt = now;
      log.info('automodel.slow_guard_strike', { p75Ms: Math.round(p75Ms), downgradeAboveMs: DOWNGRADE_ABOVE_MS });
      return;
    }
    if (now - this.slowStrikeAt < SLOW_GUARD_MIN_GAP_MS) return;

    const rungs = this.getRungs();
    const currentModelId = getCurrentModelId();
    const currentIndex = rungs.findIndex(r => r.id === currentModelId);
    const smaller = rungs[currentIndex - 1];
    this.settled = false;
    this.slowStrikeAt = 0;

    if (!smaller) {
      await updateAutoModelState({ settledAt: undefined });
      return;
    }

    // One patch, awaited before the switch: updateAutoModelState is a read-modify-write on the
    // whole settings object, so concurrent calls clobber each other and a lost settledAt clear
    // would replay as a false settle after the next SW restart.
    await updateAutoModelState({
      settledAt: undefined,
      measured: { ...this.auto.measured, [currentModelId]: { p75Ms, at: now } },
    });
    this.requestSwitch(smaller.id, 'downgrade', `sustained p75 ${Math.round(p75Ms)}ms on settled model`);
  }

  private async recordMeasurement(modelId: string, p75Ms: number): Promise<void> {
    const measured = { ...this.auto.measured, [modelId]: { p75Ms, at: Date.now() } };
    await updateAutoModelState({ measured });
  }

  /** Switching stalls all queued inference through model reload + warmup, so a decided switch is
   *  applied immediately only on an idle queue and otherwise deferred to the next queue drain. */
  private requestSwitch(targetModelId: string, direction: string, reason: string): void {
    this.pendingSwitch = { targetModelId, direction, reason };
    if (this.queueService.isIdle()) {
      void this.applyPendingSwitch();
    } else {
      log.info('automodel.switch_deferred', { direction, targetModelId, reason });
    }
  }

  private async applyPendingSwitch(): Promise<void> {
    const pending = this.pendingSwitch;
    if (!pending || !this.autoEnabled) return;
    this.pendingSwitch = null;

    if (getCurrentModelId() === pending.targetModelId) return;

    log.info('automodel.switch_applying', {
      direction: pending.direction,
      targetModelId: pending.targetModelId,
      reason: pending.reason,
    });
    // Anchor the cooldown on the attempt, not the outcome, so a failing switch is not retried in a
    // tight loop.
    await updateAutoModelState({ lastSwitchAt: Date.now() });
    try {
      await this.modelService.switchModel(pending.targetModelId);
      this.sessionSwitchCount += 1;
      await updateAutoModelState({ selectedModelId: pending.targetModelId, backend: getBackend() });
    } catch (error) {
      log.error('automodel.switch_failed', { targetModelId: pending.targetModelId, error });
    }
  }
}
