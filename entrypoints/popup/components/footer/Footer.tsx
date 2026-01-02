import { AppVersion } from '@/entrypoints/popup/components/footer/AppVersion';
import { OptionsIcon } from '@/entrypoints/popup/components/footer/OptionsIcon';

export const Footer = () => {
  return (
    <div className='flex w-full items-center bg-primary p-2'>
      <OptionsIcon />
      <AppVersion />
    </div>
  );
};
