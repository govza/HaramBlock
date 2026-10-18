import { genericVideoIdentity } from '@/entrypoints/content/video/identity/genericIdentityRules';
import { redditIdentityAdapter } from '@/entrypoints/content/video/identity/redditIdentity';
import { youTubeIdentityAdapter } from '@/entrypoints/content/video/identity/youTubeIdentityAdapter';

import type { VideoIdentity } from '@/utils/videoIdentity';

/**
 * What the content script knows about a playing video when identifying it: its source URL (empty
 * for `srcObject` streams), the page it plays on, its duration (NaN until known) and, for adapters
 * that read the DOM, the element itself.
 */
export interface VideoIdentityContext {
  sourceUrl: string;
  pageHref: string;
  durationSec: number;
  video?: HTMLVideoElement;
}

/**
 * Site-specific identification, tried before the generic rules on pages whose location it
 * matches. `resolve` returns `null` to defer to the next adapter and the generic rules, or an
 * `unknown` identity to keep the video out of the persistent cache altogether.
 */
export interface VideoIdentityAdapter {
  matches(location: URL): boolean;
  resolve(context: VideoIdentityContext): VideoIdentity | null;
}

export const VIDEO_IDENTITY_ADAPTERS: readonly VideoIdentityAdapter[] = [youTubeIdentityAdapter, redditIdentityAdapter];

const pageLocationOf = (pageHref: string): URL | null => {
  try {
    return new URL(pageHref);
  } catch {
    return null;
  }
};

export function resolveVideoIdentity(
  context: VideoIdentityContext,
  adapters: readonly VideoIdentityAdapter[] = VIDEO_IDENTITY_ADAPTERS,
): VideoIdentity {
  const location = pageLocationOf(context.pageHref);
  if (location) {
    for (const adapter of adapters) {
      if (!adapter.matches(location)) continue;
      const identity = adapter.resolve(context);
      if (identity) return identity;
    }
  }
  return genericVideoIdentity(context.sourceUrl, context.pageHref, context.durationSec);
}
