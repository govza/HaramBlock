import { queueImagesForInference } from '@/entrypoints/content/communication/sender';
import { type MediaStateManager } from '@/entrypoints/content/dom/MediaStateManager';
import { logger } from '@/utils/logger';
import { type IHostSettings, type IImagePrediction, type IImageMetadata } from '@/utils/types';

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
    onCachedPredictionsFound?: (predictions: IImagePrediction[]) => void,
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

    // Filter out images that don't need AI processing
    const imagesToProcess = images.filter(image => {
      const currentSrc = image.currentSrc || image.src;

      // Skip AI processing if blacklisted
      if (this.hostSettings.policy === 'blacklist') {
        return false;
      }

      // Skip if already processed
      return !this.stateManager.isProcessed(image, currentSrc, 'ai');
    });

    if (imagesToProcess.length === 0) return;

    // Mark all images as processed for AI processing
    imagesToProcess.forEach(image => {
      const currentSrc = image.currentSrc || image.src;
      this.stateManager.markProcessed(image, currentSrc, 'ai');
    });

    try {
      await this.processImages(imagesToProcess);
    } catch (error) {
      logger.withTag('MediaHandler').error('Failed to handle images batch:', error);
    }
  }

  /**
   * Process multiple images for AI analysis and caching
   */
  private async processImages(images: HTMLImageElement[]): Promise<void> {
    try {
      const { cachedImages, uncachedImages } = this.categorizeImages(images, this.cachedPredictions);

      if (cachedImages.length > 0) {
        // For cached predictions, we need to notify the MediaProcessor to apply styling
        const predictions = cachedImages.map(item => item.prediction);
        this.onCachedPredictionsFound?.(predictions);
      }

      if (uncachedImages.length > 0) {
        await this.queueForAiProcessing(uncachedImages);
      }
    } catch (error) {
      logger.withTag('MediaHandler').error('Failed to process images for AI:', error);
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
    cachedPredictions: IImagePrediction[],
  ): {
    cachedImages: Array<{
      image: HTMLImageElement;
      prediction: IImagePrediction;
    }>;
    uncachedImages: HTMLImageElement[];
  } {
    const predictionMap = new Map(cachedPredictions.map(p => [p.src, p]));
    const cachedImages: Array<{
      image: HTMLImageElement;
      prediction: IImagePrediction;
    }> = [];
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
    const imageDatas = await Promise.all(
      images.map(async img => {
        const src = img.currentSrc || img.src;
        const metadata = await this.extractImageMetadata(src);
        return { src, metadata };
      }),
    );

    // Filter out images with empty/invalid sources
    const validImageDatas = imageDatas.filter(imageData => imageData.src && imageData.src.trim().length > 0);

    if (validImageDatas.length === 0) {
      logger.withTag('MediaHandler').warn('No valid image sources found for AI processing');
      return;
    }

    // Store images for matching with predictions
    images.forEach(image => {
      const src = image.currentSrc || image.src;
      if (src && src.trim().length > 0) {
        const existing = this.pendingImages.get(src);

        if (existing) {
          existing.push(image);
        } else {
          this.pendingImages.set(src, [image]);
        }
      }
    });

    try {
      await queueImagesForInference(this.hostSettings.hostname, validImageDatas);
    } catch (error) {
      logger.withTag('MediaHandler').error('queueForAiProcessing - Error:', error);
      // Clean up on error
      validImageDatas.forEach(({ src }) => this.pendingImages.delete(src));
      throw error;
    }
  }

  private async extractImageMetadata(src: string): Promise<IImageMetadata | undefined> {
    try {
      // Only extract metadata for HTTP(S) URLs to avoid CORS issues
      if (!src.startsWith('http://') && !src.startsWith('https://')) {
        return undefined;
      }

      const response = await fetch(src, { method: 'HEAD' });
      if (!response.ok) {
        return undefined;
      }

      return {
        contentType: response.headers.get('content-type') || undefined,
        contentLength: (() => {
          const length = response.headers.get('content-length');
          return length ? parseInt(length, 10) : undefined;
        })(),
        lastModified: response.headers.get('last-modified') || undefined,
        cacheControl: response.headers.get('cache-control') || undefined,
        etag: response.headers.get('etag') || undefined,
        expires: response.headers.get('expires') || undefined,
      };
    } catch (error) {
      // Silently fail metadata extraction to avoid breaking image processing
      logger.withTag('MediaHandler').debug(`Failed to extract metadata for ${src}:`, error);
      return undefined;
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
