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
  if (el.dataset.hbSrc !== src) el.dataset.hbSrc = src;
  el.dataset.hbSent = '1';
}

export function isSentForInference(el: HTMLImageElement | HTMLVideoElement, src: string): boolean {
  return el.dataset.hbSrc === src && el.dataset.hbSent === '1';
}

export function markProcessed(el: HTMLImageElement | HTMLVideoElement, src: string): void {
  if (el.dataset.hbSrc !== src) el.dataset.hbSrc = src;
  el.dataset.hbProcessed = '1';
}
