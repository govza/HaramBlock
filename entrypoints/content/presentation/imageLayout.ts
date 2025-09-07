import { type IMaskTransform } from '@/utils/types';

export interface ContentRect {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

/**
 * Compute the actually rendered content rectangle of an <img> inside its element box,
 * respecting object-fit and object-position. Offsets are relative to the element box.
 */
export function computeRenderedContentRect(image: HTMLImageElement, imageRect?: DOMRect): ContentRect {
  const naturalW = image.naturalWidth || image.width;
  const naturalH = image.naturalHeight || image.height;
  const rect = imageRect ?? image.getBoundingClientRect();
  const boxW = rect.width;
  const boxH = rect.height;
  if (!naturalW || !naturalH || !boxW || !boxH) {
    return { offsetX: 0, offsetY: 0, width: boxW, height: boxH };
  }

  const style = getComputedStyle(image);
  const fit = (style.objectFit || 'fill').toLowerCase();
  const pos = (style.objectPosition || '50% 50%').trim().split(' ');

  const parsePos = (v: string, total: number, content: number): number => {
    if (!v) return (total - content) / 2;
    if (v.endsWith('%')) {
      const pct = Number(v.slice(0, -1));
      if (Number.isFinite(pct)) return ((total - content) * pct) / 100;
    }
    if (v.endsWith('px')) {
      const px = Number(v.slice(0, -2));
      if (Number.isFinite(px)) return px;
    }
    const map: Record<string, number> = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };
    if (v in map && map[v] !== undefined) return (total - content) * map[v];
    return (total - content) / 2;
  };

  if (fit === 'fill') {
    return { offsetX: 0, offsetY: 0, width: boxW, height: boxH };
  }

  if (fit === 'none') {
    const contentW = naturalW;
    const contentH = naturalH;
    const offX = parsePos(pos[0] || '50%', boxW, contentW);
    const offY = parsePos(pos[1] || '50%', boxH, contentH);
    return { offsetX: offX, offsetY: offY, width: contentW, height: contentH };
  }

  if (fit === 'contain' || fit === 'scale-down') {
    const scale = Math.min(boxW / naturalW, boxH / naturalH);
    const finalScale = fit === 'scale-down' ? Math.min(1, scale) : scale;
    const contentW = naturalW * finalScale;
    const contentH = naturalH * finalScale;
    const offX = parsePos(pos[0] || '50%', boxW, contentW);
    const offY = parsePos(pos[1] || '50%', boxH, contentH);
    return { offsetX: offX, offsetY: offY, width: contentW, height: contentH };
  }

  if (fit === 'cover') {
    const scale = Math.max(boxW / naturalW, boxH / naturalH);
    const contentW = naturalW * scale;
    const contentH = naturalH * scale;
    const offX = parsePos(pos[0] || '50%', boxW, contentW);
    const offY = parsePos(pos[1] || '50%', boxH, contentH);
    return { offsetX: offX, offsetY: offY, width: contentW, height: contentH };
  }

  return { offsetX: 0, offsetY: 0, width: boxW, height: boxH };
}

/**
 * Given maskTransform parameters (letterboxing in the model’s output grid) and the
 * original image size, compute the source rect within the mask grid that corresponds
 * to valid image pixels (excluding letterbox padding).
 */
export function maskGridSrcRect(
  maskTransform: IMaskTransform,
  originalWidth: number,
  originalHeight: number,
): { srcX: number; srcY: number; srcW: number; srcH: number } {
  const { scaleX, scaleY, offsetX, offsetY } = maskTransform;
  const srcX = offsetX;
  const srcY = offsetY;
  const srcW = originalWidth / scaleX;
  const srcH = originalHeight / scaleY;
  return { srcX, srcY, srcW, srcH };
}

/** Compute linear scales from original image coordinates to display (content) coordinates. */
export function displayScaleFromOriginal(
  originalWidth: number,
  originalHeight: number,
  contentWidth: number,
  contentHeight: number,
): { scaleX: number; scaleY: number } {
  return {
    scaleX: contentWidth / originalWidth,
    scaleY: contentHeight / originalHeight,
  };
}
