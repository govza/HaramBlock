import { Outline } from '@/entrypoints/popup/components/Outline';
import { QuickToggleSetting } from '@/entrypoints/popup/components/QuickToggleSetting';
import { Strictness } from '@/entrypoints/popup/components/Strictness';

export const Content = () => {
  return (
    <div className='grow px-2'>
      <Outline />
      <Strictness />
      <QuickToggleSetting />
    </div>
  );
};
