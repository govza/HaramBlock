import { describe, expect, it } from 'vitest';

import { DEFAULT_GLOBAL_KEY } from '@/utils/constants';
import { extractHostnameFromUrl, getEffectiveHostname } from '@/utils/hostnameUtil';

describe('hostnameUtil', () => {
  // Focus only on the main integration function that other parts of the app use
  describe('getEffectiveHostname', () => {
    it('should handle different URL and hostname formats correctly', () => {
      // Test URLs
      expect(getEffectiveHostname('https://example.com')).toBe('example.com');
      expect(getEffectiveHostname('https://www.google.com/search')).toBe('google.com');

      // Test special browser URLs
      expect(getEffectiveHostname('chrome://newtab/')).toBe(DEFAULT_GLOBAL_KEY);
      expect(getEffectiveHostname('about:blank')).toBe(DEFAULT_GLOBAL_KEY);

      // Test direct hostname input
      expect(getEffectiveHostname('www.example.com')).toBe('example.com');

      // Test edge cases
      expect(getEffectiveHostname('')).toBe(DEFAULT_GLOBAL_KEY);
      expect(getEffectiveHostname(null)).toBe(DEFAULT_GLOBAL_KEY);
      expect(getEffectiveHostname('not-a-url-with-://')).toBe(DEFAULT_GLOBAL_KEY);
    });
  });

  // Only testing the most complex function with special logic
  describe('extractHostnameFromUrl', () => {
    it('should handle special browser URLs correctly', () => {
      expect(extractHostnameFromUrl('chrome://newtab/')).toBe(DEFAULT_GLOBAL_KEY);
      expect(extractHostnameFromUrl('about:blank')).toBe(DEFAULT_GLOBAL_KEY);
      expect(extractHostnameFromUrl('moz-extension://12345/')).toBe(DEFAULT_GLOBAL_KEY);
    });

    it('should return null for invalid URLs', () => {
      expect(extractHostnameFromUrl('not-a-url')).toBeNull();
    });
  });
});
