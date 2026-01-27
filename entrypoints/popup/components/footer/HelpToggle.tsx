import { HELP_PATH } from '@/components/ui/icons';

interface HelpToggleProps {
  isOpen: boolean;
  onToggle: () => void;
}

export const HelpToggle = ({ isOpen, onToggle }: HelpToggleProps) => {
  return (
    <button
      className='cursor-pointer'
      onClick={onToggle}
      title={isOpen ? 'Close help' : 'Open help'}
      aria-label={isOpen ? 'Close help' : 'Open help'}
      aria-expanded={isOpen}
    >
      <svg
        xmlns='http://www.w3.org/2000/svg'
        fill='none'
        viewBox='0 0 24 24'
        strokeWidth={1.5}
        stroke={isOpen ? '#22c55e' : 'currentColor'}
        className='size-6'
      >
        <path strokeLinecap='round' strokeLinejoin='round' d={HELP_PATH} />
      </svg>
    </button>
  );
};
