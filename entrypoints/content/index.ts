import { initialHideImagesStyle } from "./masking/hide";
import { useContentHostSettings } from './hooks/useContentHostSettings';

export default defineContentScript({
  matches: ['<all_urls>'],
  async main() {
    // Prevents cached images from being displayed before DOMContentLoaded
    const hideInitStyle = initialHideImagesStyle();
    
    // Use the hook with a callback for when settings change
    await useContentHostSettings((updatedSettings) => {
      console.log('settings updated:', updatedSettings);
      // This will be called every time settings change!
    });
    
    hideInitStyle.remove();
  },
});
