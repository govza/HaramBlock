import type { IImagePrediction } from '@/utils/types/prediction';

/**
 * Common overlay state interface for image mask overlays
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
  currentPrediction?: IImagePrediction;
  viewportHandler?: () => void;
}

/**
 * Module API contract for image overlay implementations.
 */
export interface IMediaOverlay {
  /**
   * Creates mask overlay for the given image element
   * @param element - The image element
   * @param prediction - Prediction data with masks
   * @param skipObserverSetup - Whether to skip setting up observers (default: false)
   */
  createMaskOverlay: (
    element: HTMLImageElement,
    prediction?: IImagePrediction,
    skipObserverSetup?: boolean,
  ) => void | Promise<void>;

  /**
   * Clears/removes the mask overlay for the given element
   * @param element - The image element
   */
  clearMaskOverlay: (element: HTMLImageElement) => void;

  /**
   * Checks if the element has an active mask overlay
   * @param element - The image element
   * @returns true if overlay exists
   */
  hasMaskOverlay: (element: HTMLImageElement) => boolean;
}
