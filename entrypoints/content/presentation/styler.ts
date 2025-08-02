import {
  type IHostSettings,
  type IImagePrediction,
  type IElementPrediction,
} from '@/utils/types';

/**
 * Consolidated styling module for HaramBlock content script
 * This module centralizes all CSS injection, visual effects, and styling logic
 */

// ============================================================================
// GLOBAL STYLES & CSS INJECTION
// ============================================================================

/**
 * Hide all images on the page before the observer is connected.
 * Returns an object with a `remove` method to undo the hiding.
 */
export const injectGlobalHiding = () => {
  const styleElement = document.createElement('style');
  styleElement.textContent = `
    img {
      opacity: 0 !important;
    }
  `;

  // Append the style element to the document
  (document.head || document.documentElement).appendChild(styleElement);

  // Return an object with a `remove` method to clean up the style
  return {
    remove: () => {
      styleElement.remove();
    },
  };
};

/**
 * Inject CSS styles for prediction elements (overlays, badges, etc.)
 * @returns cleanup function to remove the styles
 */
export const injectPredictionStyles = () => {
  const styleElement = document.createElement('style');
  styleElement.id = 'haramblock-prediction-styles';
  styleElement.textContent = `
    /* Base styles for cached processed images */
    .haramblock-cached-processed {
      position: relative;
    }
    
    /* Base styles for AI-processed images */
    .haramblock-ai-processed {
      position: relative;
    }
    
    /* Base styles for blacklisted images */
    .haramblock-blacklisted {
      position: relative;
    }
    
    /* Bounding box overlay styles */
    .haramblock-bbox-overlay {
      pointer-events: none;
      z-index: 10;
    }
    
    .haramblock-bbox {
      box-sizing: border-box;
      border-radius: 2px;
      transition: opacity 0.2s ease;
    }
    
    .haramblock-bbox:hover {
      opacity: 0.8;
    }
    
    /* Class-specific bounding box colors */
    .haramblock-bbox-person {
      border-color: #ff0000 !important;
      background-color: rgba(255, 0, 0, 0.1) !important;
    }
    
    .haramblock-bbox-vehicle {
      border-color: #00ff00 !important;
      background-color: rgba(0, 255, 0, 0.1) !important;
    }
    
    .haramblock-bbox-animal {
      border-color: #0000ff !important;
      background-color: rgba(0, 0, 255, 0.1) !important;
    }
    
    /* Polygon overlay styles */
    .haramblock-polygon-overlay {
      pointer-events: none;
      z-index: 10;
    }
    
    .haramblock-polygon-overlay svg {
      overflow: visible;
    }
    
    .haramblock-polygon-overlay polygon {
      transition: opacity 0.2s ease;
    }
    
    .haramblock-polygon-overlay polygon:hover {
      opacity: 0.8;
    }
    
    /* Cached indicator badge */
    .haramblock-cached-processed::after {
      content: 'C';
      position: absolute;
      top: 4px;
      right: 4px;
      background: rgba(0, 0, 0, 0.7);
      color: white;
      padding: 2px 4px;
      border-radius: 3px;
      font-size: 12px;
      z-index: 20;
      pointer-events: none;
    }
    
    /* AI-processed indicator badge */
    .haramblock-ai-processed::after {
      content: 'AI';
      position: absolute;
      top: 4px;
      right: 4px;
      background: rgba(0, 0, 0, 0.7);
      color: white;
      padding: 2px 4px;
      border-radius: 3px;
      font-size: 12px;
      z-index: 20;
      pointer-events: none;
    }
    
    /* Blur effect for high-confidence predictions */
    .haramblock-cached-processed[style*="blur"],
    .haramblock-ai-processed[style*="blur"] {
      transition: filter 0.3s ease;
    }
    
    .haramblock-cached-processed[style*="blur"]:hover,
    .haramblock-ai-processed[style*="blur"]:hover {
      filter: none !important;
    }
  `;

  // Append the style element to the document
  (document.head || document.documentElement).appendChild(styleElement);

  // Return cleanup function
  return {
    remove: () => {
      styleElement.remove();
    },
  };
};

// ============================================================================
// HIGH-LEVEL PREDICTION APPLICATION
// ============================================================================

/**
 * Apply predictions to corresponding image elements with full styling
 * This is the main entry point for applying AI predictions to images
 * @param images - Array of HTMLImageElement to process
 * @param predictions - Array of image predictions
 * @param hostSettings - Current host settings for styling configuration
 * @param predictionSource - Source of predictions ('cached' | 'ai-processed')
 */
export const applyPredictionsStyling = (
  images: HTMLImageElement[],
  predictions: IImagePrediction[],
  hostSettings: IHostSettings,
  predictionSource: 'cached' | 'ai-processed' = 'cached',
): void => {
  // Ensure prediction styles are injected
  injectPredictionStyles();

  // Create a map of src URLs to predictions for efficient lookup
  const predictionMap = new Map<string, IImagePrediction>();
  predictions.forEach(prediction => {
    predictionMap.set(prediction.src, prediction);
  });

  // Process each image
  images.forEach(image => {
    const prediction = predictionMap.get(image.src);
    if (prediction) {
      applyImagePredictionStyling(
        image,
        prediction,
        hostSettings,
        predictionSource,
      );
    }
  });
};

/**
 * Apply styling for images that are blacklisted
 * @param image - The HTMLImageElement to apply styling to
 */
export const applyBlacklistStyling = (image: HTMLImageElement): void => {
  image.style.filter = 'blur(10px)';
  image.style.opacity = '0.3';
  image.classList.add('haramblock-blacklisted');
};

/**
 * Apply default styling to an image based on host settings
 *
 * This function applies immediate, basic styling to images before AI predictions are available.
 * It serves as the first layer of protection in the two-stage filtering system:
 * 1. Default styling (this function) - Applied immediately when images are detected
 * 2. Prediction-based styling - Applied later when AI analysis completes
 *
 * The styling is generic and doesn't require any AI analysis, making it suitable for
 * immediate application to provide basic content filtering while waiting for more
 * sophisticated AI-driven styling through applyPredictionsStyling().
 *
 * @param image - The HTMLImageElement to apply default styling to
 * @param hostSettings - Host settings containing mask configuration (e.g., blur preferences)
 */
export const applyDefaultStyling = (
  image: HTMLImageElement,
  hostSettings: IHostSettings,
): void => {
  const filters: string[] = [];
  const { masks } = hostSettings;

  if (masks.includes('blur')) {
    filters.push('blur(5px)');
  }

  if (filters.length) {
    image.style.filter = filters.join(' ');
  }
};

/**
 * Apply comprehensive AI-driven styling to a single image based on prediction data
 *
 * This is the core function for applying intelligent, prediction-based styling to individual images.
 * It serves as the second layer in the two-stage filtering system, replacing basic default styling
 * with sophisticated AI-driven visual effects based on actual content analysis.
 *
 * The function performs a complete styling workflow:
 * 1. Clears any existing HaramBlock styling to ensure clean state
 * 2. Applies base metadata and CSS classes for identification
 * 3. Conditionally applies advanced styling based on host settings:
 *    - Intelligent blur (8px) - Only applied if high-confidence predictions exist
 *    - Visual overlays - Bounding boxes or segmentation polygons
 *    - Prediction indicators - Visual badges showing processing status
 *
 * Unlike applyDefaultStyling(), this function uses prediction confidence thresholds
 * (hostSettings.strictness) to make intelligent decisions about which styling to apply,
 * ensuring that only images with confident AI predictions receive enhanced filtering.
 *
 * @param image - The HTMLImageElement to apply AI-driven styling to
 * @param prediction - AI prediction data containing detected objects and confidence scores
 * @param hostSettings - Host configuration including strictness threshold and style preferences
 * @param predictionSource - Source of predictions ('cached' from database | 'ai-processed' from fresh analysis)
 */
export const applyImagePredictionStyling = (
  image: HTMLImageElement,
  prediction: IImagePrediction,
  hostSettings: IHostSettings,
  predictionSource: 'cached' | 'ai-processed',
): void => {
  // Clear any existing HaramBlock styling
  clearElementStyles(image);

  // Apply base styling and metadata
  applyBaseStyles(image, prediction, predictionSource);

  // Apply prediction-specific styling based on host settings
  if (hostSettings.masks.includes('blur')) {
    applyPredictionBlur(image, prediction, hostSettings);
  }

  if (hostSettings.outline === 'bbox') {
    applyBoundingBoxOutline(image, prediction, hostSettings);
  } else if (hostSettings.outline === 'segment') {
    applySegmentOutline(image, prediction, hostSettings);
  }
};

/**
 * Apply bounding box outline based on predictions
 * @param image - The HTMLImageElement
 * @param prediction - The prediction data
 * @param hostSettings - Host settings containing strictness threshold
 */
export const applyBoundingBoxOutline = (
  image: HTMLImageElement,
  prediction: IImagePrediction,
  hostSettings: IHostSettings,
): void => {
  const highConfidencePredictions = prediction.predictions.filter(
    (pred: IElementPrediction) => pred.probability >= hostSettings.strictness,
  );

  if (highConfidencePredictions.length > 0) {
    const overlay = createBoundingBox(image, highConfidencePredictions);
    if (overlay && image.parentElement) {
      image.parentElement.appendChild(overlay);
    }
  }
};

/**
 * Apply segment outline based on predictions
 * @param image - The HTMLImageElement
 * @param prediction - The prediction data
 * @param hostSettings - Host settings containing strictness threshold
 */
export const applySegmentOutline = (
  image: HTMLImageElement,
  prediction: IImagePrediction,
  hostSettings: IHostSettings,
): void => {
  const highConfidencePredictions = prediction.predictions.filter(
    (pred: IElementPrediction) => pred.probability >= hostSettings.strictness,
  );

  if (highConfidencePredictions.length > 0) {
    const overlay = createPolygon(image, highConfidencePredictions);
    if (overlay && image.parentElement) {
      image.parentElement.appendChild(overlay);
    }
  }
};

// ============================================================================
// ELEMENT STYLING & MANAGEMENT
// ============================================================================

/**
 * Apply base styles and metadata to an image
 * @param image - The HTMLImageElement
 * @param prediction - The prediction data
 * @param predictionSource - Source of the prediction
 */
export const applyBaseStyles = (
  image: HTMLImageElement,
  prediction: IImagePrediction,
  predictionSource: 'cached' | 'ai-processed',
): void => {
  // Set custom properties for debugging and styling
  image.style.setProperty(
    '--prediction-count',
    prediction.predictions.length.toString(),
  );
  image.style.setProperty('--cache-timestamp', prediction.timestamp.toString());
  image.style.setProperty('--prediction-source', predictionSource);

  // Add appropriate CSS class
  const cssClass =
    predictionSource === 'cached'
      ? 'haramblock-cached-processed'
      : 'haramblock-ai-processed';
  image.classList.add(cssClass);
};

/**
 * Clear existing HaramBlock styles from an image
 * @param image - The HTMLImageElement to clean
 */
export const clearElementStyles = (image: HTMLImageElement): void => {
  // Remove HaramBlock classes
  image.classList.remove(
    'haramblock-cached-processed',
    'haramblock-ai-processed',
    'haramblock-blacklisted',
  );

  // Remove custom properties
  image.style.removeProperty('--cached-predictions');
  image.style.removeProperty('--prediction-count');
  image.style.removeProperty('--cache-timestamp');
  image.style.removeProperty('--blur-applied');
  image.style.removeProperty('--prediction-source');

  // Remove styling
  image.style.removeProperty('filter');
  image.style.removeProperty('opacity');
  image.style.removeProperty('visibility');

  // Remove existing overlays
  const parent = image.parentElement;
  if (parent) {
    const existingOverlays = parent.querySelectorAll(
      '.haramblock-bbox-overlay, .haramblock-polygon-overlay',
    );
    existingOverlays.forEach(overlay => overlay.remove());
  }
};

/**
 * Hide image and wait for load event
 * This function hides an image, waits for it to load, then shows it again
 * @param image - The HTMLImageElement to hide and wait for
 * @returns Promise that resolves when image loads or rejects on error
 */
export const hideImageAndWaitForLoad = (
  image: HTMLImageElement,
): Promise<void> => {
  return new Promise<void>((resolve, reject) => {
    // Hide the image element
    const hideElement = (): boolean => {
      if (image.style.visibility === 'hidden' || image.style.opacity === '0') {
        return false;
      }
      if (image.parentNode?.nodeName === 'BODY' && image.parentElement) {
        image.parentElement.style.visibility = 'hidden';
        return true;
      }
      image.style.visibility = 'hidden';
      return true;
    };

    // Show the image element
    const showElement = (): boolean => {
      if (image.style.visibility === 'visible' || image.style.opacity === '1') {
        return false;
      }
      if (image.parentNode?.nodeName === 'BODY' && image.parentElement) {
        image.parentElement.style.visibility = 'visible';
        return true;
      }
      image.style.visibility = 'visible';
      return true;
    };

    const isHideApplied = hideElement();

    const onLoadImage = (): void => {
      if (isHideApplied) {
        showElement();
      }
      resolve();
      cleanup();
    };

    const onErrorImage = (): void => {
      reject(new Error('Image failed to load'));
      cleanup();
    };

    const cleanup = () => {
      image.removeEventListener('load', onLoadImage);
      image.removeEventListener('error', onErrorImage);
    };

    image.addEventListener('load', onLoadImage);
    image.addEventListener('error', onErrorImage);
  });
};

/**
 * Apply blur mask based on predictions and strictness threshold
 * @param image - The HTMLImageElement to apply blur to
 * @param prediction - The prediction data
 * @param hostSettings - Host settings containing strictness threshold
 */
export const applyPredictionBlur = (
  image: HTMLImageElement,
  prediction: IImagePrediction,
  hostSettings: IHostSettings,
): void => {
  const highConfidencePredictions = prediction.predictions.filter(
    (pred: IElementPrediction) => pred.probability >= hostSettings.strictness,
  );

  if (highConfidencePredictions.length > 0) {
    image.style.filter = 'blur(8px)';
    image.style.setProperty('--blur-applied', 'true');
  }
};

// ============================================================================
// OVERLAY CREATION
// ============================================================================

/**
 * Create bounding box overlay element for an image
 * @param image - The HTMLImageElement to create overlay for
 * @param predictions - Array of predictions with bounding box data
 * @returns HTMLElement overlay or null if creation fails
 */
export const createBoundingBox = (
  image: HTMLImageElement,
  predictions: IImagePrediction['predictions'],
): HTMLElement | null => {
  if (!predictions.length) return null;

  const overlay = document.createElement('div');
  overlay.className = 'haramblock-bbox-overlay';
  overlay.style.position = 'absolute';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '10';

  predictions.forEach((prediction: IElementPrediction) => {
    const bbox = document.createElement('div');
    bbox.className = `haramblock-bbox haramblock-bbox-${prediction.className}`;
    bbox.style.position = 'absolute';

    // Calculate percentage-based positioning
    bbox.style.left = `${(prediction.boundingBox.x / image.naturalWidth) * 100}%`;
    bbox.style.top = `${(prediction.boundingBox.y / image.naturalHeight) * 100}%`;
    bbox.style.width = `${(prediction.boundingBox.width / image.naturalWidth) * 100}%`;
    bbox.style.height = `${(prediction.boundingBox.height / image.naturalHeight) * 100}%`;

    // Apply default styling (can be overridden by CSS classes)
    bbox.style.border = '2px solid red';
    bbox.style.backgroundColor = 'rgba(255, 0, 0, 0.1)';
    bbox.style.boxSizing = 'border-box';
    bbox.style.borderRadius = '2px';
    bbox.style.transition = 'opacity 0.2s ease';

    // Add metadata attributes
    bbox.setAttribute('data-class', prediction.className);
    bbox.setAttribute('data-probability', prediction.probability.toString());

    overlay.appendChild(bbox);
  });

  return overlay;
};

/**
 * Create polygon overlay element for an image
 * @param image - The HTMLImageElement to create overlay for
 * @param predictions - Array of predictions with polygon data
 * @returns HTMLElement overlay or null if creation fails
 */
export const createPolygon = (
  image: HTMLImageElement,
  predictions: IImagePrediction['predictions'],
): HTMLElement | null => {
  if (!predictions.length) return null;

  const overlay = document.createElement('div');
  overlay.className = 'haramblock-polygon-overlay';
  overlay.style.position = 'absolute';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '10';

  predictions.forEach((prediction: IElementPrediction) => {
    if (!prediction.polygon || prediction.polygon.length === 0) {
      return;
    }

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.position = 'absolute';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.setAttribute(
      'viewBox',
      `0 0 ${image.naturalWidth} ${image.naturalHeight}`,
    );

    const polygon = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'polygon',
    );

    // Convert polygon points to SVG points string
    const points = prediction.polygon
      .map((point: { x: number; y: number }) => `${point.x},${point.y}`)
      .join(' ');
    polygon.setAttribute('points', points);

    // Apply styling
    polygon.setAttribute('fill', 'rgba(255, 0, 0, 0.1)');
    polygon.setAttribute('stroke', 'red');
    polygon.setAttribute('stroke-width', '2');
    polygon.style.transition = 'opacity 0.2s ease';

    // Add metadata attributes
    polygon.setAttribute('data-class', prediction.className);
    polygon.setAttribute('data-probability', prediction.probability.toString());

    svg.appendChild(polygon);
    overlay.appendChild(svg);
  });

  return overlay;
};

/**
 * Clear all HaramBlock styles from multiple images
 * @param images - Array of images to clean, or all images if not provided
 */
export const clearAllStyles = (images?: HTMLImageElement[]): void => {
  const imagesToClean = images || Array.from(document.querySelectorAll('img'));
  imagesToClean.forEach(image => {
    if (image instanceof HTMLImageElement) {
      clearElementStyles(image);
    }
  });
};
