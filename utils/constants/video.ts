/**
 * Configuration for video frame processing loop.
 * Controls how video frames are extracted, analyzed, and filtered.
 */
export type VideoFrameLoopConfig = {
  /**
   * Interval between frame captures in milliseconds.
   * Higher values reduce CPU usage but may miss fast-changing content.
   * @default 2000
   */
  frameInterval: number;

  /**
   * Maximum number of consecutive errors before stopping frame processing.
   * Prevents infinite loops when video processing fails repeatedly.
   * @default 10
   */
  maxErrors: number;

  /**
   * Enable temporal smoothing to prevent flickering when predictions change rapidly.
   * Requires multiple consecutive positive/negative predictions before taking action.
   * @default true
   */
  enableTemporalSmoothing: boolean;

  /**
   * Number of consecutive positive (inappropriate) predictions required to trigger filtering.
   * Only applies when temporal smoothing is enabled.
   * Higher values reduce false positives but may delay filtering.
   * @default 3
   */
  positiveThreshold: number;

  /**
   * Number of consecutive negative (appropriate) predictions required to remove filtering.
   * Only applies when temporal smoothing is enabled.
   * Higher values prevent premature unblocking but may keep content filtered longer.
   * @default 5
   */
  negativeThreshold: number;

  /**
   * Maximum frames per second to send for inference.
   * Limits the rate of API calls to the background service worker.
   * If undefined, no rate limiting is applied.
   * @default 7
   */
  maxSendFps?: number;
};

/**
 * Default configuration for video frame processing.
 * Balances detection accuracy with performance and resource usage.
 */
export const DEFAULT_VIDEO_CONFIG: VideoFrameLoopConfig = {
  frameInterval: 2000,
  maxErrors: 10,
  enableTemporalSmoothing: true,
  positiveThreshold: 3,
  negativeThreshold: 5,
  maxSendFps: 7,
};
