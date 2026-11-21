import { IS_CLOUD_PREDICTIONS_SERVER_CONFIGURED } from '@/utils/cloudPredictions/config';
import {
  hasDataCollection,
  onDataCollectionChange,
  requestDataCollection,
} from '@/utils/cloudPredictions/dataCollection';
import { CONSENT_STORAGE_KEY, REPORTER_ID_STORAGE_KEY } from '@/utils/cloudPredictions/storageKeys';
import { getLogger } from '@/utils/telemetry';

import type {
  CloudPredictionsConsent,
  CloudPredictionsSection,
  ICloudPredictionsStatus,
} from '@/utils/types/cloudPredictions';

const log = getLogger('cloudPredictions');

type Gate = () => Promise<boolean>;

export const getConsent = async (): Promise<CloudPredictionsConsent> => {
  const stored = await browser.storage.local.get(CONSENT_STORAGE_KEY);
  return (stored[CONSENT_STORAGE_KEY] as CloudPredictionsConsent | undefined) ?? 'unanswered';
};

const setConsent = async (consent: CloudPredictionsConsent): Promise<void> => {
  await browser.storage.local.set({ [CONSENT_STORAGE_KEY]: consent });
  log.info('cloud_predictions.consent.changed', { consent });
};

export const getReporterId = async (): Promise<string | undefined> => {
  const stored = await browser.storage.local.get(REPORTER_ID_STORAGE_KEY);
  return stored[REPORTER_ID_STORAGE_KEY] as string | undefined;
};

const ensureReporterId = async (): Promise<void> => {
  if (await getReporterId()) return;
  await browser.storage.local.set({ [REPORTER_ID_STORAGE_KEY]: crypto.randomUUID() });
};

const isAgreed: Gate = async () => (await getConsent()) === 'agreed';

const hasServer: Gate = () => Promise.resolve(IS_CLOUD_PREDICTIONS_SERVER_CONFIGURED);

const isOnGates: readonly Gate[] = [isAgreed, hasServer, hasDataCollection];

/**
 * The single gate for reports and lookups. Every condition must hold; a new one joins
 * `isOnGates` without touching callers.
 */
export const isOn = async (): Promise<boolean> => {
  for (const gate of isOnGates) {
    if (!(await gate())) return false;
  }
  return true;
};

/**
 * The agree click, from the consent tab or the options switch. Must be the first call of the click
 * handler so Firefox's data-collection prompt still sees the user gesture; a refusal there leaves
 * the stored state as it was. Resolves whether the user ended up agreed.
 */
export const agree = async (): Promise<boolean> => {
  if (!(await requestDataCollection())) return false;
  await ensureReporterId();
  await setConsent('agreed');
  return true;
};

export const decline = (): Promise<void> => setConsent('declined');

/**
 * A Firefox data type revoked in about:addons withdraws the agreement itself, so granting it back
 * there cannot switch reporting on without a new agree click.
 */
export const declineIfDataCollectionRevoked = async (): Promise<void> => {
  if ((await getConsent()) !== 'agreed') return;
  if (await hasDataCollection()) return;
  await decline();
};

export const getCloudPredictionsStatus = async (): Promise<ICloudPredictionsStatus> => {
  const [consent, on, reporterId] = await Promise.all([getConsent(), isOn(), getReporterId()]);
  return { consent, isOn: on, reporterId };
};

/**
 * Which of the three worded options states applies. An install that never agreed has no Reporter
 * ID; once one exists, any failing gate (declined, or a revoked Firefox data type) reads as off.
 */
export const optionsSectionOf = ({ isOn: on, reporterId }: ICloudPredictionsStatus): CloudPredictionsSection => {
  if (!reporterId) return { state: 'neverAgreed' };
  return { state: on ? 'on' : 'off', reporterId };
};

export const onCloudPredictionsChange = (listener: () => void): (() => void) => {
  const storageListener = (changes: Record<string, unknown>) => {
    if (CONSENT_STORAGE_KEY in changes || REPORTER_ID_STORAGE_KEY in changes) listener();
  };
  browser.storage.local.onChanged.addListener(storageListener);
  const stopDataCollectionListener = onDataCollectionChange(listener);
  return () => {
    browser.storage.local.onChanged.removeListener(storageListener);
    stopDataCollectionListener();
  };
};
