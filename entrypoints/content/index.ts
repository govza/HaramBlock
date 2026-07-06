import { resetBadgeCount } from '@/entrypoints/content/communication/sender';
import { MediaPipeline } from '@/entrypoints/content/core/MediaPipeline';
import { useHostData } from '@/entrypoints/content/hooks/useHostData';
import {
  injectGlobalHidingDomStyles,
  injectPredictionDomStyles,
} from '@/entrypoints/content/presentation/styleInjecting';
import { logger } from '@/utils/logger';
import { warmupMessageChannel } from '@/utils/messaging/content';

let stopPipeline: (() => void) | null = null;

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  async main() {
    const ct = document.contentType;
    if (!ct || (ct !== 'text/html' && ct !== 'application/xhtml+xml' && !ct.startsWith('image/'))) return;

    logger.withTag('content').debug('Starting content script initialization...');
    warmupMessageChannel();
    // Hides images early to prevent cached images from flashing before DOMContentLoaded
    const hideInitStyle = injectGlobalHidingDomStyles();
    injectPredictionDomStyles();

    try {
      // Get host settings and cached predictions
      // Clear stale badge left by previous document in this tab (after RPC is connected)
      void resetBadgeCount();

      await useHostData(({ settings: hostSettings, predictions: cachedPredictions }) => {
        // Clean up existing instances
        if (stopPipeline) {
          stopPipeline();
          stopPipeline = null;
        }

        if (hostSettings.policy.behavior !== 'whitelist') {
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

      // No unload cleanup on purpose: after a refresh/navigation the old page stays
      // painted until the next document arrives, and tearing the overlay layer down in
      // beforeunload uncovers everything during that window. If the navigation is
      // canceled, the page keeps living and still needs a working pipeline. Resources
      // are reclaimed with the document either way.
    } catch (error) {
      logger.withTag('content').error('Error during initialization:', error);
      hideInitStyle.remove();
    }
  },
});
