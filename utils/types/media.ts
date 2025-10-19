// #region IMAGE TYPES
export type IImageMetadata = {
  contentType: string | null;
  contentLength: number | null;
  lastModified: string | null;
  cacheControl: string | null;
  etag: string | null;
  expires: string | null;
};

// --- Shared field groups ---
type MediaBase = {
  src: string;
  width: number;
  height: number;
  metadata: IImageMetadata;
};

type TransferFields = {
  hostname: string;
  tabId: number;
  bitmap: ImageBitmap;
};

// --- Image types (discriminated union) ---
export type IImageWithMetadata = {
  media: 'image';
  transport: 'serializable';
} & MediaBase;

export type IImageWithBitmap = {
  media: 'image';
  transport: 'transferable';
} & MediaBase &
  TransferFields;

// #region VIDEO TYPES
export type VideoFrameLoopConfig = {
  frameInterval: number;
  maxErrors: number;
  enableTemporalSmoothing: boolean;
  positiveThreshold: number;
  negativeThreshold: number;
  maxSendFps?: number;
};

type FrameFields = {
  sessionId: string; // Stable ID for a single <video> session
  videoUrl: string; // Original video source URL from the DOM
  frameIndex: number;
  timestampSec: number; // Frame timestamp in seconds
};

// --- Frame types (discriminated union) ---
export type IFrameWithMetadata = {
  media: 'frame';
  transport: 'serializable';
} & MediaBase &
  FrameFields;

export type IFrameWithBitmap = {
  media: 'frame';
  transport: 'transferable';
} & MediaBase &
  FrameFields &
  TransferFields;

// --- Video types ---

export type IVideoSegment = {
  startSec: number;
  endSec: number;
  classes: string[];
  maxProb: number;
};

export type IVideo =
  | {
      type: 'start';
      sessionId: string;
      videoUrl: string;
      width: number;
      height: number;
      durationSec?: number;
      fps?: number;
      loopConfig?: VideoFrameLoopConfig;
    }
  | {
      type: 'summary';
      sessionId: string;
      videoUrl: string;
      segments: IVideoSegment[];
      stats: {
        framesProcessed: number;
        avgFps?: number;
        droppedFrames?: number;
        startTime: number; // epoch ms
        endTime: number; // epoch ms
      };
    };
