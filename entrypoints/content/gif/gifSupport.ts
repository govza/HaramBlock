import { GIF_URL_PATTERN } from '@/utils/constants/gif';

/**
 * Heuristic: does this image look like an animated GIF worth multi-frame inspection?
 * Detection happens before fetching, so we rely on the URL extension or a
 * content-type hint stored on the element. Non-candidates fall back to the normal
 * single-frame image path (no regression). The decoder verifies and bails on
 * static / non-GIF data.
 */
export function isGifCandidate(src: string, contentTypeHint?: string | null): boolean {
  if (contentTypeHint && contentTypeHint.toLowerCase().includes('image/gif')) {
    return true;
  }
  return GIF_URL_PATTERN.test(src);
}
