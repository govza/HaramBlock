import { defaultGlobalKey } from '@/utils/db/constants';

/**
 * Normalize a hostname to the effective hostname used for database storage
 * Converts empty hostnames to the global key
 *
 * @param hostname - Raw hostname from URL or tab
 * @returns Normalized hostname for database operations
 */
export function normalizeHostname(hostname: string | null | undefined): string {
  if (!hostname || hostname.trim() === '') {
    return defaultGlobalKey;
  }

  // Remove www. prefix for consistency
  const cleanHostname = hostname.replace(/^www\./, '');

  return cleanHostname;
}

/**
 * Extract and normalize hostname from a URL
 * Handles special browser URLs (chrome://, moz-extension://, etc.)
 *
 * @param url - Full URL string
 * @returns Normalized hostname or null if invalid
 */
export function extractHostnameFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;

  try {
    // Treat all special browser URLs as global
    if (url.startsWith('chrome://') || url.startsWith('moz-extension://') || url.startsWith('about:')) {
      return defaultGlobalKey;
    }

    // Handle regular URLs
    const urlObj = new URL(url);
    return normalizeHostname(urlObj.hostname);
  } catch {
    return null;
  }
}

/**
 * Check if a hostname represents a global/special page
 *
 * @param hostname - Hostname to check
 * @returns True if it's a global page
 */
export function isGlobalPage(hostname: string | null | undefined): boolean {
  return normalizeHostname(hostname) === defaultGlobalKey;
}

/**
 * Get the effective hostname for database operations
 * This is the primary method that should be used throughout the extension
 *
 * @param hostname - Raw hostname or URL
 * @returns Effective hostname for database storage
 */
export function getEffectiveHostname(hostname: string | null | undefined): string {
  // If it looks like a URL, extract the hostname first
  if (hostname && (hostname.includes('://') || hostname.startsWith('about:'))) {
    return extractHostnameFromUrl(hostname) || defaultGlobalKey;
  }

  // Otherwise treat it as a hostname
  return normalizeHostname(hostname);
}
