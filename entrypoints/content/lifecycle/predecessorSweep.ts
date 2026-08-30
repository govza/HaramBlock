import {
  DVR_OVERLAY_ATTR,
  GIF_MASK_OVERLAY_ATTR,
  IMAGE_MASK_OVERLAY_ATTR,
  VIDEO_MASK_OVERLAY_ATTR,
} from '@/entrypoints/content/presentation/constants';
import { SESSION_ID_ATTR } from '@/entrypoints/content/video/session/markers';

const PREDECESSOR_OVERLAY_SELECTOR = [
  DVR_OVERLAY_ATTR,
  VIDEO_MASK_OVERLAY_ATTR,
  IMAGE_MASK_OVERLAY_ATTR,
  GIF_MASK_OVERLAY_ATTR,
]
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

  // The DVR hides the native element behind its canvases the same way. Lift
  // it so a dead canvas cannot leave an invisible video, and so this
  // instance's own DVR does not save the hidden state as the element's
  // original opacity. Videos still carrying the session marker were never
  // released by their owner.
  for (const video of document.querySelectorAll(`video[${SESSION_ID_ATTR}]`)) {
    liftInlineHide(video);
  }
};
