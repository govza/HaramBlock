import { decodeHookIdentityClaim, HOOK_IDENTITY_ATTR } from '@/utils/lookahead/protocol';
import { YOUTUBE_HOST } from '@/utils/lookahead/youTubePlayer';
import { isKeyInNamespace, UNKNOWN_VIDEO_IDENTITY, type VideoIdentity } from '@/utils/videoIdentity';

import type { VideoIdentityAdapter, VideoIdentityContext } from '@/entrypoints/content/video/identity/identityResolver';

const isYouTubeClaim = (identity: VideoIdentity): boolean => {
  if (identity.kind === 'unknown') return isKeyInNamespace(identity.pendingKey, 'yt');
  return identity.kind === 'stable' && isKeyInNamespace(identity.key, 'yt');
};

function resolveYouTubeIdentity({ sourceUrl, video }: VideoIdentityContext): VideoIdentity | null {
  if (!sourceUrl.startsWith('blob:')) return null;
  const claim = decodeHookIdentityClaim(video?.getAttribute(HOOK_IDENTITY_ATTR) ?? null);
  if (claim?.objectUrl !== sourceUrl || !isYouTubeClaim(claim.identity)) return UNKNOWN_VIDEO_IDENTITY;
  return claim.identity;
}

export const youTubeIdentityAdapter: VideoIdentityAdapter = {
  matches: location => YOUTUBE_HOST.test(location.hostname),
  resolve: resolveYouTubeIdentity,
};
