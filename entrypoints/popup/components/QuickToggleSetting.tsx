import { Switch } from '@/components/ui/Switch';
import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { t } from '@/utils/i18n';

interface SwitchRowProps {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  testId?: string;
}

const SwitchRow = ({ label, checked, disabled, onChange, testId }: SwitchRowProps) => (
  <div className='flex items-center justify-between gap-2 rtl:flex-row-reverse' data-testid={testId}>
    <span className='text-text-muted'>{label}</span>
    <Switch checked={checked} disabled={disabled} onChange={onChange} />
  </div>
);

export const QuickToggleSetting = () => {
  const { hostSettings, hostSettingsRepository, markDirty } = useHostDataContext();

  const isDisabled = hostSettings.policy !== 'process' && hostSettings.policy !== 'process-images';

  const handleUnsafeChange = (enabled: boolean) => {
    if (isDisabled) return;
    void hostSettingsRepository.setQuickToggleUnsafe(hostSettings.hostname, enabled).then(markDirty);
  };

  const handleSafeChange = (enabled: boolean) => {
    if (isDisabled) return;
    void hostSettingsRepository.setQuickToggleSafe(hostSettings.hostname, enabled).then(markDirty);
  };

  return (
    <div className='my-2 flex flex-col gap-2 text-sm'>
      <SwitchRow
        label={t('HostSettings.QuickToggle.unsafeEnabled')}
        checked={hostSettings.quickToggle.unsafeEnabled}
        disabled={isDisabled}
        onChange={handleUnsafeChange}
        testId='quick-toggle-unsafe'
      />
      <SwitchRow
        label={t('HostSettings.QuickToggle.safeEnabled')}
        checked={hostSettings.quickToggle.safeEnabled}
        disabled={isDisabled}
        onChange={handleSafeChange}
        testId='quick-toggle-safe'
      />
    </div>
  );
};
