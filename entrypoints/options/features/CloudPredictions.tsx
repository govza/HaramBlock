import { useEffect, useState } from 'react';

import { ErasureRequestLink, PrivacyPolicyLink } from '@/components/cloudPredictions/CloudPredictionsLinks';
import { slot, SlotText } from '@/components/ui/SlotText';
import { Switch } from '@/components/ui/Switch';
import { LoadingSpinner } from '@/entrypoints/options/components/LoadingSpinner';
import {
  agree,
  decline,
  getCloudPredictionsStatus,
  onCloudPredictionsChange,
  optionsSectionOf,
} from '@/utils/cloudPredictions';
import { t } from '@/utils/i18n';
import { getLogger } from '@/utils/telemetry';

import type { ICloudPredictionsStatus } from '@/utils/types';

const log = getLogger('cloudPredictionsOptions');

const useCloudPredictionsStatus = (): ICloudPredictionsStatus | undefined => {
  const [status, setStatus] = useState<ICloudPredictionsStatus>();

  useEffect(() => {
    const refresh = () => {
      getCloudPredictionsStatus()
        .then(setStatus)
        .catch((error: unknown) => log.warn('cloud_predictions.status.read_failed', { error }));
    };
    refresh();
    return onCloudPredictionsChange(refresh);
  }, []);

  return status;
};

const NeverAgreedText = () => (
  <>
    <p>{t('CloudPredictions.Options.neverAgreedIntro')}</p>
    <p>{t('CloudPredictions.Options.neverAgreedShare', [t('CloudPredictions.Options.youShareLabel')])}</p>
    <p>{t('CloudPredictions.Options.neverAgreedNeverSent', [t('CloudPredictions.Options.neverSentLabel')])}</p>
    <p>
      <SlotText
        text={t('CloudPredictions.Options.switchingOnAgrees', [slot(0)])}
        slots={[<PrivacyPolicyLink key={0} />]}
      />
    </p>
  </>
);

/**
 * Props of the parts shown once an Install ID exists: the wording whose erasure email carries it,
 * and the ID itself.
 */
interface ReporterIdProps {
  reporterId: string;
}

const OnText = ({ reporterId }: ReporterIdProps) => (
  <>
    <p>
      <SlotText text={t('CloudPredictions.Options.onSummary', [slot(0)])} slots={[<PrivacyPolicyLink key={0} />]} />
    </p>
    <p>
      <SlotText
        text={t('CloudPredictions.Options.onDeletion', [slot(0)])}
        slots={[<ErasureRequestLink key={0} reporterId={reporterId} />]}
      />
    </p>
  </>
);

const OffText = ({ reporterId }: ReporterIdProps) => (
  <>
    <p>{t('CloudPredictions.Options.offSummary')}</p>
    <p>
      <SlotText
        text={t('CloudPredictions.Options.offAgreement', [slot(0), slot(1)])}
        slots={[
          <PrivacyPolicyLink key={0} label={t('CloudPredictions.privacyPolicyInline')} />,
          <ErasureRequestLink key={1} reporterId={reporterId} />,
        ]}
      />
    </p>
  </>
);

const InstallId = ({ reporterId }: ReporterIdProps) => (
  <div className='flex flex-wrap items-center gap-3 pt-1'>
    <span className='text-sm text-text-muted'>{t('CloudPredictions.installId')}</span>
    <code className='rounded bg-primary-dark px-1.5 py-0.5 text-sm' data-testid='cloud-predictions-install-id'>
      {reporterId}
    </code>
    <button
      type='button'
      className='cursor-pointer rounded-md border border-border-secondary px-3 py-1 text-sm hover:bg-surface'
      onClick={() => {
        navigator.clipboard
          .writeText(reporterId)
          .catch((error: unknown) => log.warn('cloud_predictions.install_id.copy_failed', { error }));
      }}
    >
      {t('CloudPredictions.copy')}
    </button>
  </div>
);

export const CloudPredictions = () => {
  const status = useCloudPredictionsStatus();
  const [isSwitching, setIsSwitching] = useState(false);

  if (!status) {
    return <LoadingSpinner />;
  }

  const section = optionsSectionOf(status);

  const switchTo = (on: boolean) => {
    setIsSwitching(true);
    const change = on ? agree() : decline();
    change
      .catch((error: unknown) => log.warn('cloud_predictions.switch.failed', { error }))
      .finally(() => setIsSwitching(false));
  };

  return (
    <div className='space-y-6' data-testid='cloud-predictions' data-state={section.state}>
      <div className='flex max-w-2xl items-center justify-between gap-4 border-b border-border-primary pb-4'>
        <h2 className='text-2xl font-bold text-text-primary'>{t('CloudPredictions.name')}</h2>
        <div data-testid='cloud-predictions-switch'>
          <Switch checked={status.isOn} disabled={isSwitching} label={t('CloudPredictions.name')} onChange={switchTo} />
        </div>
      </div>

      <div className='max-w-2xl space-y-3 text-base leading-relaxed'>
        {section.state === 'neverAgreed' && <NeverAgreedText />}
        {section.state === 'on' && <OnText reporterId={section.reporterId} />}
        {section.state === 'off' && <OffText reporterId={section.reporterId} />}
        {section.state !== 'neverAgreed' && <InstallId reporterId={section.reporterId} />}
      </div>
    </div>
  );
};
