import { useState, useEffect } from 'react';

import { DEFAULT_GLOBAL_KEY } from '@/utils/constants';
import { extractHostnameFromUrl } from '@/utils/hostnameUtil';
import { getLogger } from '@/utils/telemetry';

const log = getLogger('useHostname');

/**
 * Hook for managing hostname detection
 * Handles auto-detection of current tab hostname
 */
export function useHostname() {
  const [detectedHostname, setDetectedHostname] = useState<string>(DEFAULT_GLOBAL_KEY);
  const [error, setError] = useState<string | null>(null);

  // Auto-detect current hostname from active tab
  useEffect(() => {
    const getCurrentHostName = async () => {
      try {
        const tabs = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        const urlFromTab = tabs[0]?.url;
        if (urlFromTab) {
          const currentHostname = extractHostnameFromUrl(urlFromTab);
          setDetectedHostname(currentHostname || DEFAULT_GLOBAL_KEY);
        }
      } catch (error) {
        setError('Error fetching current tab URL');
        log.error('host.tab_url.fetch_failed', { error });
      }
    };

    void getCurrentHostName();
  }, []);

  // Get the current effective hostname
  const currentHostname = detectedHostname;

  return {
    // Current state
    currentHostname,
    detectedHostname,
    error: error || undefined,
  };
}
