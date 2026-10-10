import {
  GIF_MASK_OVERLAY_ATTR,
  IMAGE_MASK_OVERLAY_ATTR,
  VIDEO_MASK_OVERLAY_ATTR,
} from '@/entrypoints/content/presentation/constants';

const PREDECESSOR_OVERLAY_SELECTOR = [VIDEO_MASK_OVERLAY_ATTR, IMAGE_MASK_OVERLAY_ATTR, GIF_MASK_OVERLAY_ATTR]
  .map(attr => `[${attr}]`)
  .join(', ');

const liftInlineHide = (element: Element | null): void => {
  const style = (element as HTMLElement | null)?.style;
  if (!style) return;
  if (style.getPropertyValue('opacity') === '0') {
    style.removeProperty('opacity');
  }
};

/**
 * Remove what a crashed predecessor instance failed to tear down. A live
 * orphan disposes its own artifacts when the sentinel supersedes it; this
 * sweep covers predecessors that died mid-teardown and could not. Runs at
 * startup before first attachment, so everything matched belongs to a
 * predecessor — this instance has not created anything yet.
 */
export const sweepPredecessorArtifacts = (): void => {
  for (const overlay of document.querySelectorAll(PREDECESSOR_OVERLAY_SELECTOR)) {
    // The GIF player hides its <img> (inline opacity 0) behind the overlay it
    // injects as the image's next sibling, and keeps the original opacity only
    // in instance memory. Lift the hide together with the overlay, or the
    // image stays invisible with nothing on top.
    if (overlay.hasAttribute(GIF_MASK_OVERLAY_ATTR)) {
      liftInlineHide(overlay.previousElementSibling);
    }
    overlay.remove();
  }
};
