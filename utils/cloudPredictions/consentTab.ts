import { getConsent } from '@/utils/cloudPredictions/consent';
import { CONSENT_TAB_SHOWN_STORAGE_KEY } from '@/utils/cloudPredictions/storageKeys';

import type { CloudPredictionsConsent } from '@/utils/types/cloudPredictions';
import type { Browser } from 'wxt/browser';

type InstallReason = Browser.runtime.InstalledDetails['reason'];

/**
 * Everything the once-only consent tab decision depends on: why `onInstalled` fired, the stored
 * answer, and whether this install already opened the tab.
 */
interface ConsentTabDecision {
  reason: InstallReason;
  consent: CloudPredictionsConsent;
  alreadyShown: boolean;
}

/**
 * Open on install, and on the first update that carries the feature, while nobody answered yet.
 * Browser and shared-module updates are not updates of this extension.
 */
export const shouldOpenConsentTab = ({ reason, consent, alreadyShown }: ConsentTabDecision): boolean =>
  (reason === 'install' || reason === 'update') && consent === 'unanswered' && !alreadyShown;

const wasConsentTabShown = async (): Promise<boolean> => {
  const stored = await browser.storage.local.get(CONSENT_TAB_SHOWN_STORAGE_KEY);
  return stored[CONSENT_TAB_SHOWN_STORAGE_KEY] === true;
};

/**
 * Records the tab as shown only after it opened, so a failed open is retried on the next update
 * instead of silently skipping the user's only prompt.
 */
export const openConsentTabIfDue = async (reason: InstallReason): Promise<void> => {
  const [consent, alreadyShown] = await Promise.all([getConsent(), wasConsentTabShown()]);
  if (!shouldOpenConsentTab({ reason, consent, alreadyShown })) return;

  await browser.tabs.create({ url: browser.runtime.getURL('/consent.html') });
  await browser.storage.local.set({ [CONSENT_TAB_SHOWN_STORAGE_KEY]: true });
};
