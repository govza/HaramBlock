import { MediaPipeline } from '@/entrypoints/content/core/MediaPipeline';
import { useHostData } from '@/entrypoints/content/hooks/useHostData';
import {
  injectGlobalHidingDomStyles,
  injectPredictionDomStyles,
} from '@/entrypoints/content/presentation/styleInjecting';
import { logger } from '@/utils/logger';

let stopPipeline: (() => void) | null = null;

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  async main() {
    logger.withTag('content').debug('Starting content script initialization...');
    // Prevents cached images from being displayed before DOMContentLoaded
    const hideInitStyle = injectGlobalHidingDomStyles();
    // Injects styles for predictions
    injectPredictionDomStyles();

    try {
      // Get host settings and cached predictions
      const hostData = await useHostData(({ settings: hostSettings, predictions: cachedPredictions }) => {
        // Clean up existing instances
        if (stopPipeline) {
          stopPipeline();
          stopPipeline = null;
        }

        if (hostSettings.policy !== 'whitelist') {
          const pipeline = new MediaPipeline({
            hostSettings,
          });
          pipeline.seedCachedPredictions(cachedPredictions);

          const startProcessing = () => {
            stopPipeline = pipeline.start(document);
            hideInitStyle.remove();
          };

          // Run after DOMContentLoaded event if the document is still loading
          if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', startProcessing, { once: true });
          } else {
            startProcessing();
          }
        } else {
          hideInitStyle.remove();
        }
      });

      // Cleanup on page unload
      globalThis.addEventListener('beforeunload', () => {
        if (stopPipeline) stopPipeline();
        hostData.cleanup();
      });
    } catch (error) {
      logger.withTag('content').error('Error during initialization:', error);
      hideInitStyle.remove();
    }
  },
});
