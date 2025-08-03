import { describe, expect, it } from 'vitest';

import { defaultGlobalKey } from '@/utils/db/constants';
import {
  extractHostnameFromUrl,
  getEffectiveHostname,
} from '@/utils/hostnameUtil';

describe('hostnameUtil', () => {
  // Focus only on the main integration function that other parts of the app use
  describe('getEffectiveHostname', () => {
    it('should handle different URL and hostname formats correctly', () => {
      // Test URLs
      expect(getEffectiveHostname('https://example.com')).toBe('example.com');
      expect(getEffectiveHostname('https://www.google.com/search')).toBe(
        'google.com',
      );

      // Test special browser URLs
      expect(getEffectiveHostname('chrome://newtab/')).toBe(defaultGlobalKey);
      expect(getEffectiveHostname('about:blank')).toBe(defaultGlobalKey);

      // Test direct hostname input
      expect(getEffectiveHostname('www.example.com')).toBe('example.com');

      // Test edge cases
      expect(getEffectiveHostname('')).toBe(defaultGlobalKey);
      expect(getEffectiveHostname(null)).toBe(defaultGlobalKey);
      expect(getEffectiveHostname('not-a-url-with-://')).toBe(defaultGlobalKey);
    });
  });

  // Only testing the most complex function with special logic
  describe('extractHostnameFromUrl', () => {
    it('should handle special browser URLs correctly', () => {
      expect(extractHostnameFromUrl('chrome://newtab/')).toBe(defaultGlobalKey);
      expect(extractHostnameFromUrl('about:blank')).toBe(defaultGlobalKey);
      expect(extractHostnameFromUrl('moz-extension://12345/')).toBe(
        defaultGlobalKey,
      );
    });

    it('should return null for invalid URLs', () => {
      expect(extractHostnameFromUrl('not-a-url')).toBeNull();
    });
  });
});
