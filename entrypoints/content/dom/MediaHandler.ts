import { IHostSettings } from '@/utils/db/hostSettings';
import { IImagePrediction } from '@/utils/db/predictionCache';
import { MediaStateManager } from './MediaStateManager';
import { queueImagesForInference } from '../communication/sender';
import { logger } from '@/utils/logger';

/**
 * Unified handler for both image and video processing
 * Consolidates media element handling with AI integration
 */
export class MediaHandler {
  private readonly pendingImages = new Map<string, HTMLImageElement[]>();
  private onCachedPredictionsFound?: (predictions: IImagePrediction[]) => void;

  constructor(
    private hostSettings: IHostSettings,
    private readonly stateManager: MediaStateManager,
    private cachedPredictions: IImagePrediction[] = [],
    onCachedPredictionsFound?: (predictions: IImagePrediction[]) => void
  ) {
    this.onCachedPredictionsFound = onCachedPredictionsFound;
  }

  // ============================================================================
  // IMAGE PROCESSING
  // ============================================================================

  /**
   * Process images for AI analysis and caching
   */
  public async handleImages(images: HTMLImageElement[]): Promise<void> {
    if (!images.length) return;

    for (const image of images) {
      await this.handleSingleImage(image);
    }
  }

  /**
   * Handle a single image with proper loading and masking
   */
  private async handleSingleImage(image: HTMLImageElement): Promise<void> {
    const currentSrc = image.currentSrc || image.src;

    // Skip AI processing if blacklisted
    if (this.hostSettings.policy === 'blacklist') {
      return;
    }

    // Check if already processed with same src for AI processing
    if (this.stateManager.isProcessed(image, currentSrc, 'ai')) {
      return;
    }

    // Mark as processed for AI processing
    this.stateManager.markProcessed(image, currentSrc, 'ai');

    try {
      await this.processImageForAI(image);
    } catch (error) {
      logger.withTag("MediaHandler").error('Failed to handle single image:', error);
    }
  }

  /**
   * Process image for AI analysis and caching
   */
  private async processImageForAI(image: HTMLImageElement): Promise<void> {
    try {
      const { cachedImages, uncachedImages } = this.categorizeImages([image], this.cachedPredictions);

      if (cachedImages.length > 0) {
        // For cached predictions, we need to notify the MediaProcessor to apply styling
        const predictions = cachedImages.map(item => item.prediction);
        this.onCachedPredictionsFound?.(predictions);
      }
      
      if (uncachedImages.length > 0) {
        await this.queueForAiProcessing(uncachedImages);
      }
      
    } catch (error) {
      logger.withTag("MediaHandler").error('Failed to process image for AI:', error);
    }
  }

  /**
   * Handle AI predictions for images
   */
  public handleAiPredictions(predictions: IImagePrediction[]): void {
    predictions.forEach(prediction => {
      const images = this.pendingImages.get(prediction.src);
      if (images) {
        this.pendingImages.delete(prediction.src);
      }
    });
  }

  private categorizeImages(
    images: HTMLImageElement[],
    cachedPredictions: IImagePrediction[]
  ): {
    cachedImages: Array<{ image: HTMLImageElement; prediction: IImagePrediction }>;
    uncachedImages: HTMLImageElement[];
  } {
    const predictionMap = new Map(cachedPredictions.map(p => [p.src, p]));
    const cachedImages: Array<{ image: HTMLImageElement; prediction: IImagePrediction }> = [];
    const uncachedImages: HTMLImageElement[] = [];

    images.forEach(image => {
      const src = image.currentSrc || image.src;
      const prediction = predictionMap.get(src);
      
      if (prediction) {
        cachedImages.push({ image, prediction });
      } else {
        uncachedImages.push(image);
      }
    });

    return { cachedImages, uncachedImages };
  }

  private async queueForAiProcessing(images: HTMLImageElement[]): Promise<void> {
    const imageSrcs = images.map(img => img.currentSrc || img.src);
    
    // Store images for matching with predictions
    images.forEach(image => {
      const src = image.currentSrc || image.src;
      const existing = this.pendingImages.get(src);
      
      if (existing) {
        existing.push(image);
      } else {
        this.pendingImages.set(src, [image]);
      }
    });

    try {
      await queueImagesForInference(this.hostSettings.hostname, imageSrcs);
      
    } catch (error) {
      logger.withTag("MediaHandler").error('queueForAiProcessing - Error:', error);
      // Clean up on error
      imageSrcs.forEach(src => this.pendingImages.delete(src));
      throw error;
    }
  }

  // ============================================================================
  // VIDEO PROCESSING
  // ============================================================================

  /**
   * Process videos based on host settings
   */
  public handleVideos(videos: HTMLVideoElement[]): void {
    if (!videos.length) return;

    for (const video of videos) {
      const currentSrc = video.currentSrc || video.src;

      // Check if already processed
      if (this.stateManager.isProcessed(video, currentSrc, 'ai')) {
        continue;
      }

      // Mark as processed
      this.stateManager.markProcessed(video, currentSrc, 'ai');

      // Apply blacklist styling if needed
      if (this.hostSettings.policy === 'blacklist') {
        this.applyBlacklistStyling([video]);
        continue;
      }

      // TODO: Implement video-specific processing
    }
  }

  private applyBlacklistStyling(videos: HTMLVideoElement[]): void {
    videos.forEach(video => {
      video.style.filter = 'blur(15px)';
      video.style.opacity = '0.2';
      video.classList.add('haramblock-blacklisted');
    });
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================

  /**
   * Clean up resources for both media types
   */
  public destroy(): void {
    this.pendingImages.clear();
  }
}
