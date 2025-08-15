import { type IElementPrediction, type IImagePrediction } from '@/utils/types';

export const createBlurBoxOverlays = (image: HTMLImageElement, imagePrediction?: IImagePrediction): void => {
  const predictions = imagePrediction?.predictions || [];
  if (!predictions.length || !image.complete || image.naturalWidth === 0) return;

  const parent = image.parentElement;
  if (!parent) return;

  if (getComputedStyle(parent).position === 'static') {
    parent.style.position = 'relative';
  }

  removeBlurBoxOverlays(image);

  const updateBlurBoxes = () => {
    removeBlurBoxOverlays(image);

    const imageRect = image.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();

    // Calculate the visible intersection of image and parent
    const visibleLeft = Math.max(imageRect.left, parentRect.left);
    const visibleTop = Math.max(imageRect.top, parentRect.top);
    const visibleRight = Math.min(imageRect.right, parentRect.right);
    const visibleBottom = Math.min(imageRect.bottom, parentRect.bottom);

    // Check if image is actually visible
    if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return;

    const imageOffsetX = imageRect.left - parentRect.left;
    const imageOffsetY = imageRect.top - parentRect.top;

    // Use stored image dimensions if available, otherwise fall back to natural dimensions
    const originalWidth = imagePrediction?.imageWidth ?? image.naturalWidth;
    const originalHeight = imagePrediction?.imageHeight ?? image.naturalHeight;

    const scaleX = imageRect.width / originalWidth;
    const scaleY = imageRect.height / originalHeight;

    predictions.forEach((prediction: IElementPrediction) => {
      const { x, y, width, height } = prediction.boundingBox;

      // Bounding box coordinates are already in original image pixel coordinates
      // Scale them to the displayed image size
      const boxLeft = imageOffsetX + x * scaleX;
      const boxTop = imageOffsetY + y * scaleY;
      const boxWidth = width * scaleX;
      const boxHeight = height * scaleY;

      // Clip blur box to visible image area
      const clippedLeft = Math.max(boxLeft, visibleLeft - parentRect.left);
      const clippedTop = Math.max(boxTop, visibleTop - parentRect.top);
      const clippedRight = Math.min(boxLeft + boxWidth, visibleRight - parentRect.left);
      const clippedBottom = Math.min(boxTop + boxHeight, visibleBottom - parentRect.top);

      // Skip if blur box is not visible
      if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) return;

      const blurBox = document.createElement('div');
      blurBox.className = 'haramblock-blur-box';
      blurBox.style.left = `${clippedLeft}px`;
      blurBox.style.top = `${clippedTop}px`;
      blurBox.style.width = `${clippedRight - clippedLeft}px`;
      blurBox.style.height = `${clippedBottom - clippedTop}px`;

      parent.appendChild(blurBox);
    });
  };

  updateBlurBoxes();

  if (!image.dataset.haramblockObserver) {
    const resizeObserver = new ResizeObserver(() => {
      updateBlurBoxes();
    });

    const handleViewportChange = () => {
      updateBlurBoxes();
    };

    resizeObserver.observe(image);
    globalThis.addEventListener('resize', handleViewportChange);
    globalThis.addEventListener('scroll', handleViewportChange, { passive: true });

    image.dataset.haramblockObserver = 'true';
  }
};

const removeBlurBoxOverlays = (image: HTMLImageElement): void => {
  const parent = image.parentElement;
  if (!parent) return;

  const blurBoxes = parent.querySelectorAll('.haramblock-blur-box');
  blurBoxes.forEach(box => box.remove());
};
