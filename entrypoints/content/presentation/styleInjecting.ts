export const injectGlobalHidingDomStyles = () => {
  const styleElement = document.createElement('style');
  styleElement.textContent = `
    img,
    video,
    shreddit-player {
      opacity: 0 !important;
    }
  `;

  (document.head || document.documentElement).appendChild(styleElement);

  return {
    remove: () => {
      styleElement.remove();
    },
  };
};

export const VIDEO_DISCOVERED_ATTR = 'data-haramblock-video-discovered';

/**
 * Keep videos born after initialization hidden until the pipeline has applied
 * their real protection. The Reddit host rule covers its shadow-root video,
 * which document-level `video` selectors cannot reach.
 */
export const injectVideoDiscoveryHidingStyles = () => {
  const styleElement = document.createElement('style');
  styleElement.textContent = `
    video:not([${VIDEO_DISCOVERED_ATTR}]),
    shreddit-player:not([${VIDEO_DISCOVERED_ATTR}]) {
      opacity: 0 !important;
    }
  `;
  (document.head || document.documentElement).appendChild(styleElement);
  return { remove: () => styleElement.remove() };
};

/** Reveal only after the video and every open-shadow host around it are protected. */
export function markVideoDiscovered(video: HTMLVideoElement): void {
  video.setAttribute(VIDEO_DISCOVERED_ATTR, '');
  let root: Node = video.getRootNode();
  while (root instanceof ShadowRoot) {
    root.host.setAttribute(VIDEO_DISCOVERED_ATTR, '');
    root = root.host.getRootNode();
  }
}

export const injectPredictionDomStyles = () => {
  if (document.getElementById('haramblock-prediction-styles')) {
    return {
      remove: () => {
        const existingElement = document.getElementById('haramblock-prediction-styles');
        existingElement?.remove();
      },
    };
  }

  const styleElement = document.createElement('style');
  styleElement.id = 'haramblock-prediction-styles';
  styleElement.textContent = `
    .haramblock-initial-blur {
      filter: blur(15px) !important;
    }
    .haramblock-eye-toggle {
      width: 2rem;
      height: 2rem;
      padding: 0.25rem;
      border: none;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.5);
      cursor: pointer;
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .haramblock-eye-toggle:hover {
      background: rgba(0, 0, 0, 0.8);
    }
    .haramblock-eye-toggle svg {
      width: 1.25rem;
      height: 1.25rem;
      opacity: 0.5;
    }
  `;

  (document.head || document.documentElement).appendChild(styleElement);

  return {
    remove: () => {
      styleElement.remove();
    },
  };
};
