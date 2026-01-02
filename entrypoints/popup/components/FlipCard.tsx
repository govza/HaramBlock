import { createContext, useContext, type ReactNode, type KeyboardEvent } from 'react';

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
      <div className='w-full overflow-hidden perspective-[1000px]'>
        <div
          className={`relative transition-transform duration-500 [transform-style:preserve-3d] ${
            isFlipped ? '[transform:rotateY(180deg)]' : ''
          }`}
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

const Front = ({ children }: FlipCardSideProps) => {
  return <div className='[backface-visibility:hidden]'>{children}</div>;
};

const Back = ({ children }: FlipCardSideProps) => {
  return (
    <div className='absolute inset-0 [backface-visibility:hidden] [transform:rotateY(180deg)]'>
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

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      flip();
    }
  };

  const ariaLabel = isFlipped ? t('FlipCard.switchToSiteSettings') : t('FlipCard.switchToDefaultSettings');

  return (
    <button
      onClick={flip}
      onKeyDown={handleKeyDown}
      className={`flex w-full cursor-pointer items-center p-2 transition-colors hover:brightness-110 ${className}`}
      aria-label={ariaLabel}
      tabIndex={0}
    >
      {children}
    </button>
  );
};

FlipCard.Front = Front;
FlipCard.Back = Back;
FlipCard.Header = Header;
