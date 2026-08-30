export interface ResolvedVideoSource {
  srcObject: HTMLVideoElement['srcObject'];
  url: string;
}

/** `srcObject` is the active source even if a previous URL is still reflected temporarily. */
export function resolveVideoSource(video: HTMLVideoElement): ResolvedVideoSource | null {
  if (video.srcObject) return { srcObject: video.srcObject, url: '' };
  const url = video.currentSrc || video.src;
  return url ? { srcObject: null, url } : null;
}
