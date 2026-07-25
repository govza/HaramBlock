/**
 * Overlay elements injected next to media, identified by their marker
 * attributes: DVR presenter canvases, video/image mask overlays, GIF players.
 */
const PREDECESSOR_OVERLAY_SELECTOR = [
  '[data-video-dvr-player]',
  '[data-video-mask-overlay]',
  '[data-mask-overlay]',
  '[data-gif-mask-player]',
].join(', ');

/**
 * Remove what a crashed predecessor instance failed to tear down. A live
 * orphan disposes its own artifacts when the sentinel supersedes it; this
 * sweep covers predecessors that died mid-teardown and could not. Runs at
 * startup before first adoption, so everything matched belongs to a
 * predecessor — this instance has not created anything yet.
 */
export const sweepPredecessorArtifacts = (): void => {
  for (const overlay of document.querySelectorAll(PREDECESSOR_OVERLAY_SELECTOR)) {
    overlay.remove();
  }

  // The DVR hides the native element behind its canvases with an inline
  // opacity 0. Lift it so a dead canvas cannot leave an invisible video, and
  // so this instance's own DVR does not save the hidden state as the
  // element's original opacity.
  for (const video of document.querySelectorAll<HTMLVideoElement>('video[data-hb-session-id]')) {
    if (video.style.getPropertyValue('opacity') === '0') {
      video.style.removeProperty('opacity');
    }
  }
};
