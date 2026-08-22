type SrcDriftHandler = (image: HTMLImageElement) => void;

let handler: SrcDriftHandler | null = null;

export const setSrcDriftHandler = (next: SrcDriftHandler | null): void => {
  handler = next;
};

export const clearSrcDriftHandler = (own: SrcDriftHandler): void => {
  if (handler === own) handler = null;
};

export const notifySrcDrift = (image: HTMLImageElement): void => {
  handler?.(image);
};
