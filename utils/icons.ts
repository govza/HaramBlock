import type { HostPolicy } from '@/utils/types';

/**
 * Helper function to get icon paths based on policy
 * Returns icon paths for different sizes based on the host policy
 */
export const getIconPaths = (policy: HostPolicy): Record<string, string> => {
  const iconBasePath = '/icon/';
  switch (policy) {
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