import { BlockedCount } from '@/entrypoints/popup/components/BlockedCount';
import { BlurIntensity } from '@/entrypoints/popup/components/BlurIntensity';
import { BlurTint } from '@/entrypoints/popup/components/BlurTint';
import { Outline } from '@/entrypoints/popup/components/Outline';
import { PixelationScale } from '@/entrypoints/popup/components/PixelationScale';
import { PolicyBehaviorSwitcher } from '@/entrypoints/popup/components/PolicyBehaviorSwitcher';
import { PolicyTargetSwitcher } from '@/entrypoints/popup/components/PolicyTargetSwitcher';
import { QuickToggleSetting } from '@/entrypoints/popup/components/QuickToggleSetting';
import { Strictness } from '@/entrypoints/popup/components/Strictness';

export const Content = () => {
  return (
    <div className='px-2 pt-2'>
      <PolicyBehaviorSwitcher />
      <PolicyTargetSwitcher />
      <BlockedCount />
      <Outline />
      <Strictness />
      <BlurTint />
      <BlurIntensity />
      <PixelationScale />
      <QuickToggleSetting />
    </div>
  );
};
