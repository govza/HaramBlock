import { genericMediaReference } from '@/entrypoints/content/video/identity/genericIdentityRules';
import { redditIdentityAdapter } from '@/entrypoints/content/video/identity/redditIdentityAdapter';
import { youTubeIdentityAdapter } from '@/entrypoints/content/video/identity/youTubeIdentityAdapter';
import { isOnHost, tryParseUrl } from '@/utils/url';
import { identityOfMediaReference } from '@/utils/videoIdentity';

import type { MediaReference, VideoIdentity } from '@/utils/types';

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
 * Site-specific naming of the playing media, tried before the generic rules on pages on one of its
 * `hosts` or their subdomains. `mediaReference` returns `null` to defer to the next adapter and the
 * generic rules, or an unidentifiable reference to keep the video out of the persistent cache.
 */
export interface VideoIdentityAdapter {
  hosts: readonly string[];
  mediaReference(context: VideoIdentityContext): MediaReference | null;
}

export const VIDEO_IDENTITY_ADAPTERS: readonly VideoIdentityAdapter[] = [youTubeIdentityAdapter, redditIdentityAdapter];

function mediaReferenceOf(context: VideoIdentityContext, adapters: readonly VideoIdentityAdapter[]): MediaReference {
  const hostname = tryParseUrl(context.pageHref)?.hostname;
  if (hostname) {
    for (const adapter of adapters) {
      if (!adapter.hosts.some(host => isOnHost(hostname, host))) continue;
      const reference = adapter.mediaReference(context);
      if (reference) return reference;
    }
  }
  return genericMediaReference(context.sourceUrl);
}

export const resolveVideoIdentity = (
  context: VideoIdentityContext,
  adapters: readonly VideoIdentityAdapter[] = VIDEO_IDENTITY_ADAPTERS,
): VideoIdentity =>
  identityOfMediaReference(mediaReferenceOf(context, adapters), context.durationSec, context.pageHref);
