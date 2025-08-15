export interface DomObserverConfig {
  onMediaAdded: (images: HTMLImageElement[], videos: HTMLVideoElement[]) => void;
  onMediaRemoved: (elements: HTMLElement[]) => void;
  onAttributesChanged: (elements: HTMLElement[]) => void;
  rescanInterval?: number; // ms - periodic rescan for missed elements
}

export class DomObserver {
  private observer: MutationObserver | null = null;

  constructor(private config: DomObserverConfig) {}

  public start(root: Node = document): void {
    if (this.observer) return;

    // Scan existing DOM for images/videos
    this.scanExistingElements(root);

    this.observer = new MutationObserver(mutations => {
      const addedImages: HTMLImageElement[] = [];
      const addedVideos: HTMLVideoElement[] = [];
      const removedElements: HTMLElement[] = [];
      const changedElements: HTMLElement[] = [];

      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          // Handle added nodes
          if (mutation.addedNodes.length > 0) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType !== Node.ELEMENT_NODE) continue;
              const element = node as HTMLElement;

              // Direct matches
              if (element.tagName === 'IMG') {
                addedImages.push(element as HTMLImageElement);
              } else if (element.tagName === 'VIDEO') {
                addedVideos.push(element as HTMLVideoElement);
              } else {
                // Find nested media elements
                element.querySelectorAll('img').forEach(img => addedImages.push(img));
                element.querySelectorAll('video').forEach(video => addedVideos.push(video));
              }
            }
          }

          // Handle removed nodes
          if (mutation.removedNodes.length > 0) {
            for (const node of mutation.removedNodes) {
              if (node.nodeType !== Node.ELEMENT_NODE) continue;
              const element = node as HTMLElement;

              if (element.tagName === 'IMG' || element.tagName === 'VIDEO') {
                removedElements.push(element);
              } else {
                // Find nested media elements
                element.querySelectorAll('img,video').forEach(media => removedElements.push(media as HTMLElement));
              }
            }
          }
        } else if (mutation.type === 'attributes') {
          const target = mutation.target as HTMLElement;
          if (target.tagName === 'IMG' || target.tagName === 'VIDEO') {
            changedElements.push(target);
          }
        }
      }

      if (addedImages.length > 0 || addedVideos.length > 0) {
        this.config.onMediaAdded(addedImages, addedVideos);
      }

      if (removedElements.length > 0) {
        this.config.onMediaRemoved(removedElements);
      }

      if (changedElements.length > 0) {
        this.config.onAttributesChanged(changedElements);
      }
    });

    this.observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'data-src', 'data-srcset', 'data-lazy-src'],
      attributeOldValue: true, // Track old values for debugging
    });
  }

  public stop(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  private scanExistingElements(root: Node): void {
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;

    const container = root.nodeType === Node.DOCUMENT_NODE ? (root as Document).documentElement : (root as Element);
    if (!container) return;

    const existingImages: HTMLImageElement[] = [];
    const existingVideos: HTMLVideoElement[] = [];

    // Find all existing images and videos
    const allImages = container.querySelectorAll('img');
    const allVideos = container.querySelectorAll('video');

    allImages.forEach(img => existingImages.push(img));
    allVideos.forEach(video => existingVideos.push(video));

    // Process existing elements if any found
    if (existingImages.length > 0 || existingVideos.length > 0) {
      this.config.onMediaAdded(existingImages, existingVideos);
    }
  }
}
