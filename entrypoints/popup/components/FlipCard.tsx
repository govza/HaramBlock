import { createContext, useContext, type ReactNode } from 'react';

import { t } from '@/utils/i18n';

type FlipCardContextType = {
  isFlipped: boolean;
  flip: () => void;
};

const FlipCardContext = createContext<FlipCardContextType | null>(null);

export const useFlipCard = () => {
  const context = useContext(FlipCardContext);
  if (!context) {
    throw new Error('useFlipCard must be used within a FlipCard');
  }
  return context;
};

type FlipCardProps = {
  children: ReactNode;
  isFlipped: boolean;
  onFlip: () => void;
};

export const FlipCard = ({ children, isFlipped, onFlip }: FlipCardProps) => {
  return (
    <FlipCardContext.Provider value={{ isFlipped, flip: onFlip }}>
      <div className='w-full overflow-hidden' style={{ perspective: '1000px' }}>
        <div
          className={`grid transition-transform duration-500 ${isFlipped ? 'rotate-y-180' : ''}`}
          style={{ transformStyle: 'preserve-3d' }}
        >
          {children}
        </div>
      </div>
    </FlipCardContext.Provider>
  );
};

type FlipCardSideProps = {
  children: ReactNode;
};

const backfaceStyle = { backfaceVisibility: 'hidden' as const };

const Front = ({ children }: FlipCardSideProps) => {
  return (
    <div className='col-start-1 row-start-1 rotate-y-0' style={backfaceStyle}>
      {children}
    </div>
  );
};

const Back = ({ children }: FlipCardSideProps) => {
  return (
    <div className='relative col-start-1 row-start-1 rotate-y-180' style={backfaceStyle}>
      {children}
      <div className='pointer-events-none absolute inset-0 bg-danger/10' />
    </div>
  );
};

type FlipCardHeaderProps = {
  children: ReactNode;
  className?: string;
};

const Header = ({ children, className = '' }: FlipCardHeaderProps) => {
  const { isFlipped, flip } = useFlipCard();
  const ariaLabel = isFlipped ? t('FlipCard.switchToSiteSettings') : t('FlipCard.switchToDefaultSettings');

  return (
    <button
      onClick={flip}
      className={`flex w-full cursor-pointer items-center p-2 transition-colors hover:brightness-110 ${className}`}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
};

FlipCard.Front = Front;
FlipCard.Back = Back;
FlipCard.Header = Header;
