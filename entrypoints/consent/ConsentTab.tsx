import { useState, type ReactNode } from 'react';

import { PrivacyPolicyLink } from '@/components/cloudPredictions/CloudPredictionsLinks';
import { slot, SlotText } from '@/components/ui/SlotText';
import { agree, decline } from '@/utils/cloudPredictions';
import { t } from '@/utils/i18n';
import { getLogger } from '@/utils/telemetry';

const log = getLogger('consentTab');

/**
 * Props of one of the three boxes; the heading colour tells what is shared from what never is.
 */
interface ConsentBoxProps {
  heading: string;
  tone: 'given' | 'never';
  children: ReactNode;
}

const ConsentBox = ({ heading, tone, children }: ConsentBoxProps) => (
  <section className='rounded-lg border border-border-primary bg-secondary px-5 py-4'>
    <h2
      className={`mb-2 text-sm font-semibold uppercase tracking-wide ${
        tone === 'given' ? 'text-success-light' : 'text-danger-light'
      }`}
    >
      {heading}
    </h2>
    {children}
  </section>
);

const closeThisTab = async (): Promise<void> => {
  const tab = await browser.tabs.getCurrent();
  if (tab?.id === undefined) {
    globalThis.close();
    return;
  }
  await browser.tabs.remove(tab.id);
};

export const ConsentTab = () => {
  const [isAnswering, setIsAnswering] = useState(false);

  const answer = (answered: Promise<boolean>) => {
    setIsAnswering(true);
    answered
      .then(isAnswered => (isAnswered ? closeThisTab() : undefined))
      .catch((error: unknown) => log.warn('cloud_predictions.consent_tab.answer_failed', { error }))
      .finally(() => setIsAnswering(false));
  };

  return (
    <div className='min-h-screen bg-primary text-base leading-relaxed text-text-body' data-testid='consent-tab'>
      <main className='mx-auto max-w-2xl px-4 py-10'>
        <p className='mb-5 text-sm uppercase tracking-widest text-text-muted'>
          {t('CloudPredictions.ConsentTab.brand')}
        </p>
        <h1 className='mb-3 text-3xl font-bold leading-tight text-text-primary'>
          {t('CloudPredictions.ConsentTab.title')}
        </h1>
        <p className='mb-5'>{t('CloudPredictions.ConsentTab.intro')}</p>

        <div className='mb-4 space-y-3'>
          <ConsentBox heading={t('CloudPredictions.ConsentTab.youGet')} tone='given'>
            <p>
              {t('CloudPredictions.ConsentTab.getLead')} {t('CloudPredictions.ConsentTab.getBody')}
            </p>
          </ConsentBox>
          <ConsentBox heading={t('CloudPredictions.ConsentTab.youShare')} tone='given'>
            <ul className='list-disc space-y-1.5 ps-5'>
              <li>{t('CloudPredictions.ConsentTab.shareMasks', [t('CloudPredictions.ConsentTab.shareMasksLead')])}</li>
              <li>{t('CloudPredictions.ConsentTab.shareAddress')}</li>
              <li>{t('CloudPredictions.ConsentTab.shareChoices')}</li>
              <li>{t('CloudPredictions.ConsentTab.shareId')}</li>
              <li>{t('CloudPredictions.ConsentTab.shareReview')}</li>
            </ul>
          </ConsentBox>
          <ConsentBox heading={t('CloudPredictions.ConsentTab.neverSent')} tone='never'>
            <p>{t('CloudPredictions.ConsentTab.neverSentBody')}</p>
          </ConsentBox>
        </div>

        <p>
          <SlotText
            text={t('CloudPredictions.ConsentTab.closing', [slot(0)])}
            slots={[<PrivacyPolicyLink key={0} />]}
          />
        </p>

        <div className='mt-5 flex flex-wrap items-center gap-3'>
          <button
            type='button'
            className='cursor-pointer rounded-lg border border-accent bg-accent px-6 py-2.5 font-semibold text-white hover:bg-accent-dark disabled:cursor-not-allowed disabled:opacity-50'
            disabled={isAnswering}
            onClick={() => answer(agree())}
            data-testid='consent-agree'
          >
            {t('CloudPredictions.ConsentTab.agree')}
          </button>
          <button
            type='button'
            className='cursor-pointer rounded-lg border border-border-secondary px-6 py-2.5 text-text-body hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50'
            disabled={isAnswering}
            onClick={() => answer(decline().then(() => true))}
            data-testid='consent-not-now'
          >
            {t('CloudPredictions.ConsentTab.notNow')}
          </button>
          <span>{t('CloudPredictions.ConsentTab.eitherWay')}</span>
        </div>
      </main>
    </div>
  );
};
