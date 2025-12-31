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
    .haramblock-blur-box {
      position: absolute;
      backdrop-filter: blur(15px);
      ${import.meta.env.DEV ? 'border: 2px solid red;' : ''}
      pointer-events: none;
      z-index: 5;
    }
    .haramblock-blur-box-grayscale {
      backdrop-filter: blur(15px) grayscale(100%);
    }
    .haramblock-blur-box-dark {
      backdrop-filter: blur(15px);
      background: rgba(0, 0, 0, 0.6);
    }
    .haramblock-initial-blur {
      filter: blur(15px) !important;
    }
    .haramblock-blacklist {
      filter: blur(10px) !important;
      opacity: 0.3 !important;
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
