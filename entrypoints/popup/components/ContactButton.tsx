import { EMAIL_PATH } from '@/components/ui/icons';
import packageJson from '@/package.json';
import { t } from '@/utils/i18n';
import { backgroundRpc } from '@/utils/messaging/popup';

const EMAIL = 'admin@haramblock.com';

const buildMailtoUrl = (logsCopied: boolean) => {
  const subject = t('HelpPanel.mailSubject', [packageJson.version]);
  const logsHint = logsCopied ? t('HelpPanel.logsCopiedHint') : t('HelpPanel.logsFailedHint');
  const body = t('HelpPanel.mailBody', [logsHint]);
  return `mailto:${EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
};

/**
 * Copies the telemetry log export to the clipboard, then opens a prefilled
 * bug-report email (mailto cannot attach files, so logs travel via paste).
 */
export const ContactButton = () => {
  const handleClick = () => {
    backgroundRpc
      .getTelemetryExport()
      .then(data => navigator.clipboard.writeText(JSON.stringify(data, null, 2)))
      .then(
        () => globalThis.open(buildMailtoUrl(true)),
        () => globalThis.open(buildMailtoUrl(false)),
      );
  };

  return (
    <button
      className='cursor-pointer'
      onClick={handleClick}
      title={t('HelpPanel.contactUs')}
      aria-label={t('HelpPanel.contactUs')}
    >
      <svg className='size-5 hover:text-white' viewBox='0 0 24 24'>
        <path fill='currentColor' d={EMAIL_PATH} />
      </svg>
    </button>
  );
};
