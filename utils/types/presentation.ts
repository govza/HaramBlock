import type { IImagePrediction, IFramePrediction } from '@/utils/types/prediction';

/**
 * Union type for all media prediction types
 */
export type IMediaPrediction = IImagePrediction | IFramePrediction;

/**
 * Common overlay state interface for both image and video mask overlays
 */
export interface IMediaOverlayState {
  overlay: HTMLDivElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  resizeObserver: ResizeObserver;
  cleanupObserver: MutationObserver;
  lastSize: { width: number; height: number };
  rafId?: number | null;
  destroyed?: boolean;
  currentPrediction?: IMediaPrediction;
  viewportHandler?: () => void;
  posterImage?: HTMLImageElement; // Only used for video overlays
}

/**
 * Module API contract for media overlay implementations.
 * Both image and video overlay modules should export functions matching this signature.
 */
export interface IMediaOverlay<TElement extends HTMLImageElement | HTMLVideoElement> {
  /**
   * Creates mask overlay for the given media element
   * @param element - The media element (img or video)
   * @param prediction - Prediction data with masks (IImagePrediction for images, IFramePrediction for videos)
   * @param skipObserverSetup - Whether to skip setting up observers (default: false)
   * @returns Promise or void depending on implementation
   */
  createMaskOverlay: (
    element: TElement,
    prediction?: IMediaPrediction,
    skipObserverSetup?: boolean,
  ) => void | Promise<void>;

  /**
   * Clears/removes the mask overlay for the given element
   * @param element - The media element
   */
  clearMaskOverlay: (element: TElement) => void;

  /**
   * Checks if the element has an active mask overlay
   * @param element - The media element
   * @returns true if overlay exists
   */
  hasMaskOverlay: (element: TElement) => boolean;
}
