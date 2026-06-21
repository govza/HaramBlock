import { LoadingSpinner } from '@/entrypoints/options/components/LoadingSpinner';
import { BlurIntensity } from '@/entrypoints/popup/components/BlurIntensity';
import { BlurTint } from '@/entrypoints/popup/components/BlurTint';
import { Outline } from '@/entrypoints/popup/components/Outline';
import { PixelationScale } from '@/entrypoints/popup/components/PixelationScale';
import { PolicyBehaviorSwitcher } from '@/entrypoints/popup/components/PolicyBehaviorSwitcher';
import { PolicyTargetSwitcher } from '@/entrypoints/popup/components/PolicyTargetSwitcher';
import { QuickToggleSetting } from '@/entrypoints/popup/components/QuickToggleSetting';
import { Strictness } from '@/entrypoints/popup/components/Strictness';
import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { t } from '@/utils/i18n';

export const Overview = () => {
  const { isLoading } = useHostDataContext();

  if (isLoading) {
    return <LoadingSpinner />;
  }

  return (
    <div className='space-y-6'>
      <div className='border-b border-border-primary pb-4'>
        <h2 className='text-2xl font-bold text-text-primary mb-2'>{t('HostSettings.global')}</h2>
        <p className='text-text-muted text-base'>{t('HostSettings.description')}</p>
      </div>

      <div className='max-w-md space-y-2'>
        <PolicyBehaviorSwitcher />
        <PolicyTargetSwitcher />
        <Outline />
        <Strictness />
        <BlurTint />
        <BlurIntensity />
        <PixelationScale />
        <QuickToggleSetting />
      </div>
    </div>
  );
};
