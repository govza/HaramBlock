export function isHandled(el: HTMLImageElement | HTMLVideoElement, src: string): boolean {
  return el.dataset.hbSrc === src && el.dataset.hbHandled === '1';
}

export function markHandled(el: HTMLImageElement | HTMLVideoElement, src: string): void {
  el.dataset.hbSrc = src;
  el.dataset.hbHandled = '1';
  el.dataset.hbSent = '0';
  el.dataset.hbProcessed = '0';
}

export function markSentForInference(el: HTMLImageElement | HTMLVideoElement, src: string): void {
  // Only mark as sent if we're still tracking this src
  // If src changed, skip updating - the mutation observer handles the new src
  if (el.dataset.hbSrc !== src) {
    return;
  }
  el.dataset.hbSent = '1';
}

export function isSentForInference(el: HTMLImageElement | HTMLVideoElement, src: string): boolean {
  return el.dataset.hbSrc === src && el.dataset.hbSent === '1';
}

export function markProcessed(el: HTMLImageElement | HTMLVideoElement, src: string): void {
  // Only mark as processed if we're still tracking this src
  // If src changed, skip updating - the mutation observer handles the new src
  if (el.dataset.hbSrc !== src) {
    return;
  }
  el.dataset.hbHandled = '1';
  el.dataset.hbProcessed = '1';
}

// =============================================================================
// Video Thumbnail Status Tracking
// =============================================================================

export function markThumbnailSentForInference(video: HTMLVideoElement, src: string): void {
  // Only mark if we're still tracking this src
  if (video.dataset.hbSrc !== src) {
    return;
  }
  video.dataset.hbThumbnailSent = '1';
}

export function isThumbnailSentForInference(video: HTMLVideoElement, src: string): boolean {
  return video.dataset.hbSrc === src && video.dataset.hbThumbnailSent === '1';
}

export function markThumbnailProcessed(video: HTMLVideoElement, src: string): void {
  // Only mark if we're still tracking this src
  if (video.dataset.hbSrc !== src) {
    return;
  }
  video.dataset.hbThumbnailProcessed = '1';
}

export function isThumbnailProcessed(video: HTMLVideoElement, src: string): boolean {
  return video.dataset.hbSrc === src && video.dataset.hbThumbnailProcessed === '1';
}
