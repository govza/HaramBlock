import type { IImagePrediction } from '@/utils/types';

/**
 * In-memory FIFO cache of image predictions keyed by src.
 * Eviction follows insertion order; updating an existing src keeps its
 * original position (no LRU refresh).
 */
export class PredictionCache {
  private readonly entries = new Map<string, IImagePrediction>();

  constructor(private readonly maxSize: number) {}

  get size(): number {
    return this.entries.size;
  }

  get(src: string): IImagePrediction | undefined {
    return this.entries.get(src);
  }

  set(src: string, prediction: IImagePrediction): void {
    this.entries.set(src, prediction);
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
