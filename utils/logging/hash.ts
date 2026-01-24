/**
 * Fast FNV-1a hash, returns short hex string (4 chars).
 * Same URL always produces same hash.
 */
export const hashUrl = (url: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return (hash >>> 0).toString(16).slice(0, 4);
};
