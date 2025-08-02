import { type IHostSettings } from '@/utils/types';

export interface ElementState {
  lastProcessedSrc: string;
  processedAt: number;
  element: HTMLElement;
  processedForStyling?: boolean;
  processedForAI?: boolean;
}

export class MediaStateManager {
  private processedElements = new WeakMap<HTMLElement, ElementState>();
  private hostSettings: IHostSettings;

  constructor(initialSettings: IHostSettings) {
    this.hostSettings = initialSettings;
  }

  public getHostSettings(): IHostSettings {
    return this.hostSettings;
  }

  public markProcessed(
    element: HTMLElement,
    currentSrc: string,
    type: 'styling' | 'ai' = 'ai',
  ): void {
    const existingState = this.processedElements.get(element);

    const state: ElementState = {
      lastProcessedSrc: currentSrc,
      processedAt: Date.now(),
      element,
      processedForStyling:
        existingState?.processedForStyling || type === 'styling',
      processedForAI: existingState?.processedForAI || type === 'ai',
    };

    this.processedElements.set(element, state);
  }

  public isProcessed(
    element: HTMLElement,
    currentSrc: string,
    type: 'styling' | 'ai' = 'ai',
  ): boolean {
    const state = this.processedElements.get(element);
    if (!state || state.lastProcessedSrc !== currentSrc) {
      return false;
    }

    return type === 'styling'
      ? Boolean(state.processedForStyling)
      : Boolean(state.processedForAI);
  }

  public getElementState(element: HTMLElement): ElementState | undefined {
    return this.processedElements.get(element);
  }

  public clearProcessedElements(): void {
    this.processedElements = new WeakMap();
  }
}
