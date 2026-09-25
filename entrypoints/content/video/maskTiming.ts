export interface TransientHitConfig {
  readonly maxSuppressedRun: number;
  readonly confidenceCoefficient: number;
  readonly confidenceCap: number;
}

export const SAMPLE_FLOOR_MS = 250;

export const RELIEVED_SAMPLE_FLOOR_MS = 1000;

export const COVERAGE_MAX_GAP_SEC = 2;

export const BRIDGE_HORIZON_SEC = 3;

export const PRE_MASK_LEAD_SEC = 0.15;

export const TRANSIENT_HIT_CONFIG = {
  maxSuppressedRun: 3,
  confidenceCoefficient: 1.5,
  confidenceCap: 0.95,
} as const satisfies TransientHitConfig;
