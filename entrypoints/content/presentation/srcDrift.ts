type SrcDriftHandler = (image: HTMLImageElement) => void;

let handler: SrcDriftHandler | null = null;

export const setSrcDriftHandler = (next: SrcDriftHandler | null): void => {
  handler = next;
};

/** Clears only if `own` is still registered: a disposed owner must not wipe a successor's handler. */
export const clearSrcDriftHandler = (own: SrcDriftHandler): void => {
  if (handler === own) handler = null;
};

/**
 * Reports that an element's `currentSrc` no longer matches the source its
 * overlay was built for. Responsive images re-select a srcset candidate on
 * resize (e.g. a lightbox enlarging the element) without any attribute
 * mutation, so DomObserver never sees it — the overlay's self-clean is the
 * only detector. The drift is a change hint like any other: Reconciler
 * subscribes here and marks the image dirty, and the Reconciliation Loop's
 * processing path takes the fail-closed invalidation route.
 */
export const notifySrcDrift = (image: HTMLImageElement): void => {
  handler?.(image);
};
