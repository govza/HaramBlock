import { decodeHookIdentityClaim, HOOK_IDENTITY_ATTR } from '@/utils/lookahead/protocol';
import { UNIDENTIFIABLE_MEDIA_REFERENCE, type MediaReference } from '@/utils/videoIdentity';

import type { VideoIdentityAdapter, VideoIdentityContext } from '@/entrypoints/content/video/identity/identityResolver';

const isYouTubeReference = (reference: MediaReference): boolean =>
  reference.kind === 'stable' && reference.namespace === 'yt';

function claimedMediaReference({ sourceUrl, video }: VideoIdentityContext): MediaReference | null {
  if (!sourceUrl.startsWith('blob:')) return null;
  const claim = decodeHookIdentityClaim(video?.getAttribute(HOOK_IDENTITY_ATTR) ?? null);
  if (claim?.objectUrl !== sourceUrl || !isYouTubeReference(claim.reference)) return UNIDENTIFIABLE_MEDIA_REFERENCE;
  return claim.reference;
}

export const youTubeIdentityAdapter: VideoIdentityAdapter = {
  hosts: ['youtube.com', 'youtube-nocookie.com'],
  mediaReference: claimedMediaReference,
};
