import { openConsentTabIfDue } from '@/utils/cloudPredictions';
import { deleteLegacyCacheDatabases } from '@/utils/db/db';
import { getLogger } from '@/utils/telemetry';

const log = getLogger('installListener');

/**
 * Must run synchronously during background startup: an `onInstalled` listener registered after
 * the first tick misses the event.
 */
export const initInstallListener = (): void => {
  browser.runtime.onInstalled.addListener(({ reason }) => {
    deleteLegacyCacheDatabases().catch((error: unknown) => {
      log.warn('cache.legacy_delete.failed', { error });
    });

    openConsentTabIfDue(reason).catch((error: unknown) => {
      log.warn('cloud_predictions.consent_tab.open_failed', { error });
    });
  });
};
