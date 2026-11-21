import { declineIfDataCollectionRevoked, onDataCollectionChange } from '@/utils/cloudPredictions';
import { getLogger } from '@/utils/telemetry';

const log = getLogger('dataCollectionListener');

const declineIfRevoked = (): void => {
  declineIfDataCollectionRevoked().catch((error: unknown) => {
    log.warn('cloud_predictions.revoked_decline.failed', { error });
  });
};

/**
 * Also checks once at startup, for a revocation that happened while the background was not
 * running to hear it.
 */
export const initDataCollectionListener = (): void => {
  onDataCollectionChange(declineIfRevoked);
  declineIfRevoked();
};
