import { MediaStateManager } from './MediaStateManager';
import { MediaHandler } from './MediaHandler';
import { IHostSettings } from '@/utils/db/hostSettings';
import { IImagePrediction } from '@/utils/db/predictionCache';
import {
  applyPredictionsStyling, applyBlacklistStyling, applyDefaultStyling, hideImageAndWaitForLoad
} from '../presentation/styler';
import { logger } from '@/utils/logger';

interface ProcessorConfig {
  throttleDelay: number;
  batchSize: number;
  mutationThrottleDelay: number;
  mutationConfig: MutationObserverInit;
}

const DEFAULT_CONFIG: ProcessorConfig = {
  throttleDelay: 500,
  batchSize: 20,
  mutationThrottleDelay: 100,
  mutationConfig: {
    attributes: true,
    attributeFilter: ['src', 'srcset', 'data-src'],
    childList: true,
    subtree: true,
  },
};

/**
  * MediaProcessor handles media elements in the DOM, applying styles and processing images/videos
 */
export class MediaProcessor {
  private observer: MutationObserver | null = null;
  private stateManager: MediaStateManager;
  private mediaHandler: MediaHandler;
  private batchTimeout: number | null = null;
  private mutationTimeout: number | null = null;
  private pendingMutations: MutationRecord[] = [];
  private pendingImages: HTMLImageElement[] = [];
  private pendingVideos: HTMLVideoElement[] = [];
  private onInitialProcessingComplete?: () => void;
  private initialProcessingCompleted = false;

  constructor(
    hostSettings: IHostSettings, 
    cachedPredictions: IImagePrediction[] = [],
    private config: ProcessorConfig = DEFAULT_CONFIG
  ) {
    this.stateManager = new MediaStateManager(hostSettings);
    this.mediaHandler = new MediaHandler(
      hostSettings, 
      this.stateManager, 
      cachedPredictions,
      (predictions) => this.handleInferenceResults(predictions)
    );
    this.setupEventListeners();
    logger.withTag("MediaProcessor").debug('MediaProcessor initialized');
  }

  public start(target: Node = document, onInitialProcessingComplete?: () => void): void {
    this.onInitialProcessingComplete = onInitialProcessingComplete;
    this.observer = new MutationObserver(this.throttledMutationHandler.bind(this));
    this.observer.observe(target, this.config.mutationConfig);
    this.processExistingElements(target);
  }

  public stop(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.clearBatchTimeout();
    this.clearMutationTimeout();
    this.mediaHandler.destroy();
  }

  public handleInferenceResults(predictions: IImagePrediction[]): void {
    // Apply styling directly using presentation layer functions
    predictions.forEach(prediction => {
      // Find images with matching src
      const images = Array.from(document.querySelectorAll('img')).filter(img => {
        const src = img.currentSrc || img.src;
        return src === prediction.src;
      }) as HTMLImageElement[];

      if (images.length > 0) {
        applyPredictionsStyling(images, [prediction], this.stateManager.getHostSettings(), 'ai-processed');
        
        images.forEach(image => {
          this.stateManager.markProcessed(image, prediction.src, 'styling');
        });
      }
    });
  }

  public getState() {
    return {
      isProcessing: this.batchTimeout !== null,
      isMutationThrottling: this.mutationTimeout !== null,
      pendingMutations: this.pendingMutations.length,
      pendingImages: this.pendingImages.length,
      pendingVideos: this.pendingVideos.length,
      hostSettings: this.stateManager.getHostSettings()
    };
  }

  private throttledMutationHandler(mutations: MutationRecord[]): void {
    this.pendingMutations.push(...mutations);
    
    if (this.mutationTimeout !== null) {
      return;
    }

    this.mutationTimeout = window.setTimeout(() => {
      const allMutations = [...this.pendingMutations];
      this.pendingMutations = [];
      this.mutationTimeout = null;
      this.handleMutations(allMutations);
    }, this.config.mutationThrottleDelay);
  }

  private handleMutations(mutations: MutationRecord[]): void {
    const { images, videos } = this.extractMediaFromMutations(mutations);
    
    if (images.length > 0) {
      this.queueImages(images);
    }
    
    if (videos.length > 0) {
      this.queueVideos(videos);
    }
  }

  private extractMediaFromMutations(mutations: MutationRecord[]): {
    images: HTMLImageElement[];
    videos: HTMLVideoElement[];
  } {
    const imageSet = new Set<HTMLImageElement>();
    const videoSet = new Set<HTMLVideoElement>();

    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            this.collectMediaElements(node as HTMLElement, imageSet, videoSet);
          }
        });
      }

      if (mutation.type === 'attributes' && mutation.target.nodeType === Node.ELEMENT_NODE) {
        const element = mutation.target as HTMLElement;
        if (element.tagName === 'IMG') {
          imageSet.add(element as HTMLImageElement);
        } else if (element.tagName === 'VIDEO') {
          videoSet.add(element as HTMLVideoElement);
        }
      }
    }

    return {
      images: Array.from(imageSet),
      videos: Array.from(videoSet)
    };
  }

  private collectMediaElements(
    node: HTMLElement,
    images: Set<HTMLImageElement>,
    videos: Set<HTMLVideoElement>
  ): void {
    if (node.tagName === 'IMG') {
      images.add(node as HTMLImageElement);
    } else if (node.tagName === 'VIDEO') {
      videos.add(node as HTMLVideoElement);
    }

    // Check children
    const imgChildren = node.querySelectorAll('img');
    const videoChildren = node.querySelectorAll('video');
    
    imgChildren.forEach(img => images.add(img));
    videoChildren.forEach(video => videos.add(video));
  }

  private queueImages(images: HTMLImageElement[]): void {
    const newImages = images.filter(img => {
      const src = img.currentSrc || img.src;
      const isProcessed = this.stateManager.isProcessed(img, src, 'styling');
      return src && !isProcessed;
    });

    if (newImages.length > 0) {
      newImages.forEach(img => this.processImageImmediately(img));
      this.pendingImages.push(...newImages);
      this.scheduleBatchProcessing();
    }
  }

  private queueVideos(videos: HTMLVideoElement[]): void {
    const newVideos = videos.filter(video => {
      const src = video.currentSrc || video.src;
      return src && !this.stateManager.isProcessed(video, src, 'styling');
    });

    if (newVideos.length > 0) {
      this.pendingVideos.push(...newVideos);
      this.scheduleBatchProcessing();
    }
  }

  private scheduleBatchProcessing(): void {
    if (this.batchTimeout !== null) {
      clearTimeout(this.batchTimeout);
    }

    this.batchTimeout = window.setTimeout(() => {
      this.processBatches();
    }, this.config.throttleDelay);
  }

  private async processBatches(): Promise<void> {
    try {
      // Process images
      if (this.pendingImages.length > 0) {
        const images = [...this.pendingImages];
        this.pendingImages = [];
        
        const validImages = images.filter(img => {
          const src = img.currentSrc || img.src;
          const isValid = src && img.width >= 50 && img.height >= 50;
          return isValid;
        });
        
        if (validImages.length > 0) {
          await this.mediaHandler.handleImages(validImages);
        }
      }
      // Process videos
      if (this.pendingVideos.length > 0) {
        const videos = [...this.pendingVideos];
        this.pendingVideos = [];
        
        this.mediaHandler.handleVideos(videos);
      }
    } catch (error) {
      logger.withTag("MediaProcessor").error('Failed to process media batches:', error);
    } finally {
      this.batchTimeout = null;
    }
  }

  private processExistingElements(target: Node): void {
    let images: HTMLImageElement[] = [];
    let videos: HTMLVideoElement[] = [];

    if (target.nodeType === Node.DOCUMENT_NODE) {
      // Handle document node (e.g., when image is opened in its own tab)
      const document = target as Document;
      images = Array.from(document.querySelectorAll('img')) as HTMLImageElement[];
      videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    } else if (target.nodeType === Node.ELEMENT_NODE) {
      // Handle element node
      const element = target as HTMLElement;
      images = Array.from(element.querySelectorAll('img')) as HTMLImageElement[];
      videos = Array.from(element.querySelectorAll('video')) as HTMLVideoElement[];
    } else {
      // For other node types, call completion callback and return
      if (this.onInitialProcessingComplete && !this.initialProcessingCompleted) {
        setTimeout(() => {
          if (this.onInitialProcessingComplete && !this.initialProcessingCompleted) {
            this.initialProcessingCompleted = true;
            this.onInitialProcessingComplete();
          }
        }, 10);
      }
      return;
    }

    if (images.length > 0) this.queueImages(images);
    if (videos.length > 0) this.queueVideos(videos);

    // Call completion callback after processing existing elements
    if (this.onInitialProcessingComplete && !this.initialProcessingCompleted) {
      const delay = images.length > 0 || videos.length > 0 ? 50 : 10;
      setTimeout(() => {
        if (this.onInitialProcessingComplete && !this.initialProcessingCompleted) {
          this.initialProcessingCompleted = true;
          this.onInitialProcessingComplete();
        }
      }, delay);
    }
  }

  private clearBatchTimeout(): void {
    if (this.batchTimeout !== null) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
    }
  }

  private clearMutationTimeout(): void {
    if (this.mutationTimeout !== null) {
      clearTimeout(this.mutationTimeout);
      this.mutationTimeout = null;
    }
  }

  /**
   * Process image immediately for hiding and masking
   */
  private processImageImmediately(image: HTMLImageElement): void {
    const currentSrc = image.currentSrc || image.src;

    this.stateManager.markProcessed(image, currentSrc, 'styling');

    if (this.stateManager.getHostSettings().policy === 'blacklist') {
      applyBlacklistStyling(image);
      return;
    }

    if (!image.complete || image.naturalWidth === 0) {
      
      hideImageAndWaitForLoad(image)
        .then(() => {
          applyDefaultStyling(image, this.stateManager.getHostSettings());
        })
        .catch(() => {
          // Do nothing if image fails to load
        });
    } else {
      applyDefaultStyling(image, this.stateManager.getHostSettings());
    }
  }

  private setupEventListeners(): void {
    window.addEventListener('beforeunload', () => {
      this.stop();
    });
  }
}
