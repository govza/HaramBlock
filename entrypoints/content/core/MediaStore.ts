import type { IImagePrediction } from '@/utils/types';

export interface ElementState {
  lastHandledSrc: string;
  handled: boolean;
  sentForInference: boolean;
  processed: boolean;
}

interface MediaGroup {
  element: HTMLImageElement | HTMLVideoElement;
  state: ElementState;
  prediction?: IImagePrediction;
}

export class MediaStore {
  private groups = new Map<string, MediaGroup>();
  private elementToSrc = new WeakMap<Element, string>();

  constructor() {}

  // Element management
  private getOrCreateGroup(src: string, element: HTMLImageElement | HTMLVideoElement): MediaGroup {
    const g = this.groups.get(src);
    if (g) return g;
    const created: MediaGroup = {
      element,
      state: {
        lastHandledSrc: src,
        handled: false,
        sentForInference: false,
        processed: false,
      },
    };
    this.groups.set(src, created);
    return created;
  }

  public removeElementBySource(src: string, el: HTMLImageElement | HTMLVideoElement): void {
    const g = this.groups.get(src);
    if (!g || g.element !== el) return;
    this.groups.delete(src);
    const mapped = this.elementToSrc.get(el);
    if (mapped === src) this.elementToSrc.delete(el);
  }

  // Handled state: Image found in DOM and initial styles applied
  public markHandled(el: HTMLImageElement | HTMLVideoElement, currentSrc: string): void {
    const prevSrc = this.elementToSrc.get(el);
    if (prevSrc && prevSrc !== currentSrc) {
      const prevGroup = this.groups.get(prevSrc);
      if (prevGroup && prevGroup.element === el) {
        this.groups.delete(prevSrc);
      }
    }

    const group = this.getOrCreateGroup(currentSrc, el);
    group.state = {
      ...group.state,
      lastHandledSrc: currentSrc,
      handled: true,
    };
    this.elementToSrc.set(el, currentSrc);
  }

  public isHandled(el: HTMLImageElement | HTMLVideoElement, currentSrc: string): boolean {
    const group = this.groups.get(currentSrc);
    if (!group || group.element !== el || group.state.lastHandledSrc !== currentSrc) return false;
    return group.state.handled;
  }

  // SentForInference state: Image sent for analysis
  public markSentForInference(currentSrc: string): void {
    const group = this.groups.get(currentSrc);
    if (!group) return;
    group.state = {
      ...group.state,
      sentForInference: true,
    };
  }

  public isSentForInference(currentSrc: string): boolean {
    const group = this.groups.get(currentSrc);
    return group?.state.sentForInference ?? false;
  }

  // Processed state: Image returned from analysis with result
  public markProcessed(currentSrc: string): void {
    const group = this.groups.get(currentSrc);
    if (!group) return;
    group.state = {
      ...group.state,
      processed: true,
    };
  }

  public isProcessed(currentSrc: string): boolean {
    const group = this.groups.get(currentSrc);
    return group?.state.processed ?? false;
  }

  public getImagesBySource(src: string): HTMLImageElement[] {
    const g = this.groups.get(src);
    if (!g || g.element.tagName !== 'IMG') return [];
    return [g.element as HTMLImageElement];
  }

  // Prediction management
  public getPrediction(src: string): IImagePrediction | undefined {
    return this.groups.get(src)?.prediction;
  }

  public seedPredictions(preds: IImagePrediction[]): void {
    preds.forEach(p => {
      const group = this.groups.get(p.src);
      if (group) {
        group.prediction = p;
      }
    });
  }

  public upsertPredictions(preds: IImagePrediction[]): void {
    preds.forEach(p => {
      const group = this.groups.get(p.src);
      if (group) {
        group.prediction = p;
        group.state = {
          ...group.state,
          processed: true,
        };
      }
    });
  }

  public clear(): void {
    this.groups.clear();
  }
}
