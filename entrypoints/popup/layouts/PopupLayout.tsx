import type { ReactNode } from 'react';

type PopupLayoutProps = {
  children: ReactNode;
};

export const PopupLayout = ({ children }: PopupLayoutProps) => {
  return (
    <div className='min-w-[320px] min-h-[100vh] flex-col items-center overflow-hidden bg-primary text-text-body'>
      {children}
    </div>
  );
};
