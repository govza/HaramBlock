import type { PolicyBehavior } from '@/utils/types';

/**
 * Helper function to get icon paths based on the policy behavior
 * Returns icon paths for different sizes based on the host policy behavior
 */
export const getIconPaths = (behavior: PolicyBehavior): Record<string, string> => {
  const iconBasePath = '/icon/';
  switch (behavior) {
    case 'blacklist':
      return {
        '16': `${iconBasePath}icon16-blacklist.png`,
        '24': `${iconBasePath}icon24-blacklist.png`,
        '32': `${iconBasePath}icon32-blacklist.png`,
        '48': `${iconBasePath}icon48-blacklist.png`,
        '128': `${iconBasePath}icon128-blacklist.png`,
      };
    case 'whitelist':
      return {
        '16': `${iconBasePath}icon16-whitelist.png`,
        '24': `${iconBasePath}icon24-whitelist.png`,
        '32': `${iconBasePath}icon32-whitelist.png`,
        '48': `${iconBasePath}icon48-whitelist.png`,
        '128': `${iconBasePath}icon128-whitelist.png`,
      };
    case 'process':
    default:
      return {
        '16': `${iconBasePath}16.png`,
        '24': `${iconBasePath}24.png`,
        '32': `${iconBasePath}32.png`,
        '48': `${iconBasePath}48.png`,
        '128': `${iconBasePath}128.png`,
      };
  }
};

/**
 * Spinner icon for loading states
 */
export const spinner = () => {
  return `
    <svg
      class="animate-spin h-5 w-5 text-gray-400"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        class="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        stroke-width="4"
      ></circle>
      <path
        class="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2.93 6.343A8.003 8.003 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3.93-1.595zM20.485 4.515A8.003 8.003 0 0112 20v4c6.627 0 12-5.373 12-12h-4c0 .686-.07 1.353-.202 2H20a8.003 8.003 0 00-.515-1.485zM16.07 17.657A8.003 8.003 0 0120 12h4c0-3.042-1.135-5.824-3-7.938l-3.93 1.595z"
      ></path>
    </svg>
  `;
};
