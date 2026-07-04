import type { IHostSettings, IMaskingSettings } from '@/utils/types/host';
import type { IImagePrediction } from '@/utils/types/prediction';

/** Viewport-space rectangle in CSS pixels. */
export interface ILayerRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** `clip-path: inset(...)` values, relative to the element box. */
export interface IClipInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Geometry delivered to a layer slot: where the tracked element is, and how it is clipped. */
export interface ILayerGeometry {
  rect: ILayerRect;
  /** Insets to clip the slot to its scroll containers; null when the element is fully clipped out. */
  clip: IClipInsets | null;
  /** True when the element is fully covered by opaque foreign content (e.g. a lightbox). */
  occluded: boolean;
}

/**
 * A slot in the extension-owned overlay layer. The layer positions the slot over its
 * tracked element; renderers append their canvases to `root` and redraw on geometry
 * callbacks.
 */
export interface IOverlaySlot {
  /** Slot container inside the layer; renderers append their canvases here. */
  readonly root: HTMLElement;
  /** Force a geometry re-read on the next tracker tick. */
  refresh: () => void;
  /** Remove the slot and stop tracking the element. */
  release: () => void;
}

/**
 * Common overlay state interface for mask overlays rendered into the overlay layer.
 */
export interface IMediaOverlayState {
  slot: IOverlaySlot;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** Element size from the last geometry callback; a change triggers a redraw. */
  lastSize: { width: number; height: number };
  destroyed?: boolean;
  currentPrediction?: IImagePrediction;
  posterImage?: HTMLImageElement;
  corsVideo?: HTMLVideoElement;
  /** The src this overlay was created for - used for self-cleaning on src change */
  trackedSrc?: string;
  masking: IMaskingSettings;
  /** Decoded RLE grids for currentPrediction, so geometry updates don't re-decode. */
  decodedMasks?: { masks: number[][] }[];
  /** The prediction decodedMasks was computed from (reference identity). */
  decodedFor?: IImagePrediction;
}

/**
 * Module API contract for overlay implementations.
 * Generic over the element type (HTMLImageElement or HTMLVideoElement).
 */
export interface IMediaOverlay<T extends HTMLElement = HTMLImageElement> {
  /**
   * Creates mask overlay for the given element
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
