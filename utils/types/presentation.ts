import type { IHostSettings, IMaskingSettings } from '@/utils/types/host';
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
  posterImage?: HTMLImageElement;
  corsVideo?: HTMLVideoElement;
  /** The src this overlay was created for - used for self-cleaning on src change */
  trackedSrc?: string;
  masking: IMaskingSettings;
}

/**
 * Module API contract for overlay implementations.
 * Generic over the element type (HTMLImageElement or HTMLVideoElement).
 */
export interface IMediaOverlay<T extends HTMLElement = HTMLImageElement> {
  /**
   * Creates mask overlay for the given element. Implementations may accept
   * extra optional trailing parameters (e.g. an abort predicate).
   * @param element - The media element
   * @param prediction - Prediction data with masks
   * @param hostSettings - Host settings for eye toggle configuration
   */
  createMaskOverlay: (element: T, prediction: IImagePrediction, hostSettings: IHostSettings) => void | Promise<void>;

  /**
   * Clears/removes the mask overlay for the given element
   * @param element - The media element
   */
  clearMaskOverlay: (element: T) => void;

  /**
   * Checks if the element has an active mask overlay
   * @param element - The media element
   * @returns true if overlay exists
   */
  hasMaskOverlay: (element: T) => boolean;
}
