import { EMAIL_PATH, GITHUB_PATH, GLOBE_PATH } from '@/components/ui/icons';
import { PerformanceStats } from '@/entrypoints/popup/components/PerformanceStats';
import { t } from '@/utils/i18n';

interface HelpPanelProps {
  isOpen: boolean;
}

const LINKS = {
  github: 'https://github.com/govza/HaramBlock',
  email: 'mailto:admin@haramblock.com',
  website: 'https://haramblock.com',
};

export const HelpPanel = ({ isOpen }: HelpPanelProps) => {
  return (
    <div
      className={`grid transition-[grid-template-rows] duration-500 ${isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
    >
      <div className='overflow-hidden'>
        {isOpen && (
          <div className='border-t border-gray-600 bg-gray-800 text-gray-300 px-3 py-2 text-xs'>
            <div>{t('HelpPanel.tooltip')}</div>
            <div className='flex items-center gap-2 mt-2'>
              <span>{t('HelpPanel.contact')}</span>
              <a href={LINKS.github} target='_blank' rel='noopener noreferrer' title='GitHub' aria-label='GitHub'>
                <svg className='size-5 hover:text-white' viewBox='0 0 24 24'>
                  <path fill='currentColor' d={GITHUB_PATH} />
                </svg>
              </a>
              <a href={LINKS.email} title='Email' aria-label='Email'>
                <svg className='size-5 hover:text-white' viewBox='0 0 24 24'>
                  <path fill='currentColor' d={EMAIL_PATH} />
                </svg>
              </a>
              <a href={LINKS.website} target='_blank' rel='noopener noreferrer' title='Website' aria-label='Website'>
                <svg className='size-5 hover:text-white' viewBox='0 0 24 24'>
                  <path fill='currentColor' d={GLOBE_PATH} />
                </svg>
              </a>
            </div>

            <PerformanceStats isActive={isOpen} />
          </div>
        )}
      </div>
    </div>
  );
};
