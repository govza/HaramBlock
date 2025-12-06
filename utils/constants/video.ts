export type VideoFrameLoopConfig = {
  /** Minimum interval between frame captures in milliseconds. */
  frameInterval: number;

  /** Maximum number of consecutive errors before stopping frame processing. */
  maxErrors: number;

  /** Maximum frames per second to send for inference. */
  maxSendFps?: number;
};

export const DEFAULT_VIDEO_CONFIG: VideoFrameLoopConfig = {
  frameInterval: 100,
  maxErrors: 10,
  maxSendFps: 10,
};
