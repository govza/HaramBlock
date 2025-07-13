import { useState, useEffect } from 'react';
import { defaultGlobalKey } from '@/utils/db/hostSettings';

/**
 * Hook for managing hostname detection
 * Handles auto-detection of current tab hostname
 */
export function useHostname() {
  const [detectedHostname, setDetectedHostname] = useState<string>(defaultGlobalKey);
  const [error, setError] = useState<string | null>(null);

  // Auto-detect current hostname from active tab
  useEffect(() => {
    const getCurrentHostName = async () => {
      try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        const urlFromTab = tabs[0]?.url;
        if (urlFromTab) {
          const currentHostname = new URL(urlFromTab).hostname.replace(/^www\./, '');
          setDetectedHostname(currentHostname);
        }
      } catch (error) {
        setError('Error fetching current tab URL');
        console.error('Error fetching current tab URL:', error);
      }
    };

    getCurrentHostName();
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
