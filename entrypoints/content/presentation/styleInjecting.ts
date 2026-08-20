const hideRule = (selectors: string[]) => `
    ${selectors.join(',\n    ')} {
      opacity: 0 !important;
    }
  `;

export const injectGlobalHidingDomStyles = () => {
  const styleElement = document.createElement('style');
  styleElement.textContent = hideRule(['img', 'video', 'shreddit-player']);

  (document.head || document.documentElement).appendChild(styleElement);

  return {
    remove: () => {
      styleElement.remove();
    },
    /** Platforms where video processing is withdrawn (ADR 0003) must never hold videos hidden. */
    stopHidingVideos: () => {
      styleElement.textContent = hideRule(['img']);
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
    .haramblock-eye-toggle:hover {
      background: rgba(0, 0, 0, 0.8) !important;
    }
  `;

  (document.head || document.documentElement).appendChild(styleElement);

  return {
    remove: () => {
      styleElement.remove();
    },
  };
};
