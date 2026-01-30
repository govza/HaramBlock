import { AppVersion } from '@/entrypoints/popup/components/footer/AppVersion';
import { HelpToggle } from '@/entrypoints/popup/components/footer/HelpToggle';
import { ModelToggle } from '@/entrypoints/popup/components/footer/ModelToggle';
import { OptionsIcon } from '@/entrypoints/popup/components/footer/OptionsIcon';

interface FooterProps {
  isHelpOpen: boolean;
  onHelpToggle: () => void;
}

export const Footer = ({ isHelpOpen, onHelpToggle }: FooterProps) => {
  return (
    <div className='flex w-full items-center gap-1 bg-primary p-2'>
      <OptionsIcon />
      <div className='flex-1' />
      <AppVersion />
      <ModelToggle />
      <HelpToggle isOpen={isHelpOpen} onToggle={onHelpToggle} />
    </div>
  );
};
