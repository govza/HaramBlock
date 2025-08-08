import { onInferencePredictions } from '@/entrypoints/content/communication/listener';
import { MediaProcessor } from '@/entrypoints/content/dom/MediaProcessor';
import { useHostData } from '@/entrypoints/content/hooks/useHostData';
import { injectGlobalHiding } from '@/entrypoints/content/presentation/styler';
import { logger } from '@/utils/logger';

let currentProcessor: MediaProcessor | null = null;
let inferenceCleanup: (() => void) | null = null;

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  async main() {
    logger.withTag('content').debug('Starting content script initialization...');
    // Prevents cached images from being displayed before DOMContentLoaded
    const hideInitStyle = injectGlobalHiding();
    try {
      // Use the unified hook to get both settings and cached predictions
      const hostData = await useHostData(({ settings: hostSettings, predictions: cachedPredictions }) => {
        // Clean up existing instances
        if (currentProcessor) {
          currentProcessor.stop();
        }
        if (inferenceCleanup) {
          inferenceCleanup();
          inferenceCleanup = null;
        }

        if (hostSettings.policy !== 'whitelist') {
          // Create new processor with settings and cached predictions
          currentProcessor = new MediaProcessor(hostSettings, cachedPredictions);

          // Set up inference results listener
          inferenceCleanup = onInferencePredictions(data => {
            if (currentProcessor) {
              currentProcessor.handleInferenceResults(data.predictions);
            }
          });

          const startProcessing = () => {
            if (currentProcessor) {
              currentProcessor.start(document, () => {
                hideInitStyle.remove();
              });
            }
          };

          // Run after DOMContentLoaded event if the document is still loading
          if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', startProcessing);
          } else {
            startProcessing();
          }
        } else {
          hideInitStyle.remove();
        }
      });

      // Cleanup on page unload
      globalThis.addEventListener('beforeunload', () => {
        if (currentProcessor) {
          currentProcessor.stop();
        }
        if (inferenceCleanup) {
          inferenceCleanup();
        }
        hostData.cleanup();
      });
    } catch (error) {
      logger.withTag('content').error('Error during initialization:', error);
      hideInitStyle.remove();
    }
  },
});
