/**
 * crypto.randomUUID is undefined in non-secure contexts (plain http: pages,
 * which content scripts on <all_urls> do reach); getRandomValues is not.
 */
export function generateNonce(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
