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
