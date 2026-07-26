import { resetBadgeCount } from '@/entrypoints/content/communication/sender';
import { MediaPipeline } from '@/entrypoints/content/core/MediaPipeline';
import { useHostData } from '@/entrypoints/content/hooks/useHostData';
import { InstanceLifecycle } from '@/entrypoints/content/lifecycle/instanceLifecycle';
import { claimInstanceSentinel } from '@/entrypoints/content/lifecycle/instanceSentinel';
import { sweepPredecessorArtifacts } from '@/entrypoints/content/lifecycle/predecessorSweep';
import { removeRemainingInitialStyling } from '@/entrypoints/content/presentation/initialStyling';
import {
  injectGlobalHidingDomStyles,
  injectPredictionDomStyles,
  injectVideoDiscoveryHidingStyles,
} from '@/entrypoints/content/presentation/styleInjecting';
import { isExtensionContextValid } from '@/utils/extensionContext';
import { logger } from '@/utils/logger';
import { onMessageChannelPermanentDeath, warmupMessageChannel } from '@/utils/messaging/content';

let stopPipeline: (() => void) | null = null;

export default defineContentScript({
  matches: ['<all_urls>'],
  // Media inside same-origin iframes was previously unprotected: sites render real
  // content in frames (Bing's image-detail overlay iframe opens from search results
  // with the main image inside it — zero masks without this). Every frame runs the
  // full pipeline; inference stays shared in the background.
  allFrames: true,
  runAt: 'document_start',
  async main() {
    const ct = document.contentType;
    if (!ct || (ct !== 'text/html' && ct !== 'application/xhtml+xml' && !ct.startsWith('image/'))) return;

    logger.withTag('content').debug('Starting content script initialization...');
    // Claim the page before anything else: stamping the sentinel makes any
    // orphaned predecessor (extension reload/update) tear itself down, and the
    // sweep removes what a crashed predecessor could not.
    const onSuperseded = claimInstanceSentinel();
    sweepPredecessorArtifacts();

    // Hide media before page code can paint it. `shreddit-player` is included
    // because document styles cannot reach the video inside its shadow root;
    // hiding the host closes Reddit's pre-discovery first-frame gap.
    const hideInitStyle = injectGlobalHidingDomStyles();
    injectPredictionDomStyles();

    const lifecycle = new InstanceLifecycle({
      isContextValid: isExtensionContextValid,
      onSuperseded,
      onTransportDead: onMessageChannelPermanentDeath,
      stopPipeline: () => {
        if (stopPipeline) {
          stopPipeline();
          stopPipeline = null;
        }
      },
      // The strip is document-wide but cannot eat a successor's styling: on
      // the supersede path it runs in the sentinel stamp's microtask
      // checkpoint, before the successor's `await useHostData` (a message
      // round-trip, at least one macrotask) can have styled anything; on the
      // transport-death path a successor would already have superseded us via
      // the sentinel, so no successor exists.
      removeInitialStyling: () => {
        hideInitStyle.remove();
        removeRemainingInitialStyling();
      },
    });
    // Subscribe before the channel warmup below so an establishment failure
    // can never fire the permanent-death event into a missing listener.
    lifecycle.start();
    warmupMessageChannel();

    try {
      // Get host settings and cached predictions
      // Clear stale badge left by previous document in this tab (after RPC is connected).
      // Top frame only: the badge is per-tab absolute, and an iframe loading mid-session
      // (e.g. Bing's detail overlay) must not wipe the top document's count.
      if (globalThis.self === globalThis.top) void resetBadgeCount();

      await useHostData(({ settings: hostSettings, predictions: cachedPredictions }) => {
        // Orphaned while the settings request was in flight: creating the
        // pipeline now would resurrect an instance that already failed open.
        if (lifecycle.isTornDown) return;

        // Clean up existing instances
        if (stopPipeline) {
          stopPipeline();
          stopPipeline = null;
        }

        if (hostSettings.policy.behavior !== 'whitelist') {
          const protectsVideos =
            hostSettings.policy.behavior === 'blacklist' ||
            (hostSettings.policy.behavior === 'process' && hostSettings.policy.targets.video);
          // Install before removing the broad startup hide. This narrower rule
          // remains for late Reddit/custom-player construction and is removed
          // with the pipeline when settings change.
          const videoDiscoveryStyle = protectsVideos ? injectVideoDiscoveryHidingStyles() : null;
          const pipeline = new MediaPipeline({
            hostSettings,
          });
          pipeline.seedCachedPredictions(cachedPredictions);

          // DomObserver accepts Document and handles an incomplete tree. Start
          // immediately so custom elements and their late shadow roots are
          // watched during page construction, then reveal only after the
          // synchronous initial scan has applied per-element protection.
          const stopMediaPipeline = pipeline.start(document);
          stopPipeline = () => {
            stopMediaPipeline();
            videoDiscoveryStyle?.remove();
          };
          hideInitStyle.remove();
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
