import type { ReactNode } from 'react';

type PopupLayoutProps = {
  children: ReactNode;
};

export const PopupLayout = ({ children }: PopupLayoutProps) => {
  return <div className='flex min-h-screen min-w-[320px] flex-col bg-primary text-text-body'>{children}</div>;
};
