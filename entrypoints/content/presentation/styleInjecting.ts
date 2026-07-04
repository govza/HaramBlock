export const injectGlobalHidingDomStyles = () => {
  const styleElement = document.createElement('style');
  styleElement.textContent = `
    img {
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

export const injectPredictionDomStyles = () => {
  if (document.getElementById('haramblock-prediction-styles')) {
    return {
      remove: () => {
        const existingElement = document.getElementById('haramblock-prediction-styles');
        existingElement?.remove();
      },
    };
  }

  // Eye-toggle styles live inside the overlay layer's shadow root (quickToggle.ts) —
  // page-level CSS cannot cross the shadow boundary.
  const styleElement = document.createElement('style');
  styleElement.id = 'haramblock-prediction-styles';
  styleElement.textContent = `
    .haramblock-initial-blur {
      filter: blur(15px) !important;
    }
  `;

  (document.head || document.documentElement).appendChild(styleElement);

  return {
    remove: () => {
      styleElement.remove();
    },
  };
};
