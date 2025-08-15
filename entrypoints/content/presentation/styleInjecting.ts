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
      backdrop-filter: blur(8px);
      ${import.meta.env.DEV ? 'border: 2px solid red;' : ''}
      pointer-events: none;
      z-index: 5;
    }
    .haramblock-initial-blur {
      filter: blur(15px) !important;
    }
    .haramblock-blacklist {
      filter: blur(10px) !important;
      opacity: 0.3 !important;
    }
  `;

  (document.head || document.documentElement).appendChild(styleElement);

  return {
    remove: () => {
      styleElement.remove();
    },
  };
};
