import { BlurIntensity } from '@/entrypoints/popup/components/BlurIntensity';
import { BlurTint } from '@/entrypoints/popup/components/BlurTint';
import { Outline } from '@/entrypoints/popup/components/Outline';
import { PixelationScale } from '@/entrypoints/popup/components/PixelationScale';
import { QuickToggleSetting } from '@/entrypoints/popup/components/QuickToggleSetting';
import { Strictness } from '@/entrypoints/popup/components/Strictness';

export const Content = () => {
  return (
    <div className='grow px-2'>
      <Outline />
      <Strictness />
      <BlurTint />
      <BlurIntensity />
      <PixelationScale />
      <QuickToggleSetting />
    </div>
  );
};
