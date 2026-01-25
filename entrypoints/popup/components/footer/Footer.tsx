import { AppVersion } from '@/entrypoints/popup/components/footer/AppVersion';
import { ConsoleToggle } from '@/entrypoints/popup/components/footer/ConsoleToggle';
import { OptionsIcon } from '@/entrypoints/popup/components/footer/OptionsIcon';

export const Footer = () => {
  return (
    <div className='flex w-full items-center gap-1 bg-primary p-2'>
      <OptionsIcon />
      <ConsoleToggle />
      <div className='flex-1' />
      <AppVersion />
    </div>
  );
};
