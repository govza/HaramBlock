import { erasureRequestMailto, PRIVACY_POLICY_URL } from '@/utils/cloudPredictions/links';
import { t } from '@/utils/i18n';

const LINK_CLASS = 'text-accent-light hover:underline';

/**
 * Props of the privacy policy link; a label replaces the capitalised default where the link sits
 * mid-sentence.
 */
interface PrivacyPolicyLinkProps {
  label?: string;
}

export const PrivacyPolicyLink = ({ label = t('CloudPredictions.privacyPolicy') }: PrivacyPolicyLinkProps) => (
  <a href={PRIVACY_POLICY_URL} target='_blank' rel='noopener noreferrer' className={LINK_CLASS}>
    {label}
  </a>
);

/**
 * Props of the erasure link: the Install ID the prefilled email carries.
 */
interface ErasureRequestLinkProps {
  reporterId: string;
}

export const ErasureRequestLink = ({ reporterId }: ErasureRequestLinkProps) => (
  <a
    href={erasureRequestMailto(
      t('CloudPredictions.deleteMailSubject'),
      t('CloudPredictions.deleteMailBody', [reporterId]),
    )}
    className={LINK_CLASS}
    data-testid='cloud-predictions-erasure-link'
  >
    {t('CloudPredictions.askDelete')}
  </a>
);
