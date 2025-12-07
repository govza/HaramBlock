import React from 'react';

import { t } from '@/utils/i18n';

export interface TabItem {
  id: string;
  label: string;
}

interface VerticalTabsProps {
  items: TabItem[];
  activeTab: string;
  onTabChange: (id: string) => void;
  children: Record<string, React.ReactNode>;
}

export function VerticalTabs({ items, activeTab, onTabChange, children }: VerticalTabsProps) {
  return (
    <div className='grid grid-cols-[200px_1fr] h-full border border-border-primary'>
      <nav className='border-r border-border-primary bg-primary'>
        <div className='p-4 border-b border-border-primary'>
          <div className='flex items-center gap-3 mb-2'>
            <img src='/logo.svg' alt={t('Extension.name')} className='w-8 h-8' />
            <h1 className='text-xl font-bold text-text-primary'>{t('Extension.name')}</h1>
          </div>
          <p className='text-sm text-text-muted'>Extension Options</p>
        </div>
        <ul>
          {items.map(item => (
            <li key={item.id}>
              <button
                className={`w-full text-left px-4 py-3 text-base hover:bg-surface-light cursor-pointer transition-all duration-200 ease-in-out ${
                  activeTab === item.id
                    ? 'bg-secondary font-medium border-l-4 border-accent text-text-primary'
                    : 'text-text-body hover:text-text-primary'
                }`}
                onClick={() => onTabChange(item.id)}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main className='p-6 bg-primary text-text-body'>
        <div key={activeTab} className='animate-in fade-in slide-in-from-right-4 duration-300 ease-out'>
          {children[activeTab]}
        </div>
      </main>
    </div>
  );
}
