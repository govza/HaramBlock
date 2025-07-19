
/**
 * Hide all images on the page before the observer is connected.
 * Returns an object with a `remove` method to undo the hiding.
 */
export const initialHideImagesStyle = () => {
  const styleElement = document.createElement('style');
  styleElement.textContent = `
    img {
      opacity: 0 !important;
    }
  `;

  // Append the style element to the document
  (document.head || document.documentElement).appendChild(styleElement);

  // Return an object with a `remove` method to clean up the style
  return {
    remove: () => {
      styleElement.remove();
    },
  };
};
