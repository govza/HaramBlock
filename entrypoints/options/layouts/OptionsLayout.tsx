import type { ReactNode } from 'react';

type OptionsLayoutProps = {
  sidebar: ReactNode;
  children: ReactNode;
};

export const OptionsLayout = ({ sidebar, children }: OptionsLayoutProps) => {
  return (
    <div className='min-h-screen bg-primary text-text-body'>
      <div className='flex'>
        <aside className='w-1/6 min-w-[200px] bg-primary border-r border-border-primary min-h-screen'>{sidebar}</aside>

        <main className='flex-1 p-8 bg-primary'>
          <div className='max-w-4xl'>{children}</div>
        </main>
      </div>
    </div>
  );
};
