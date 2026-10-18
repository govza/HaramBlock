import { HOOK_IDENTITY_ATTR } from '@/utils/lookahead/protocol';
import { YOUTUBE_HOST } from '@/utils/lookahead/youTubePlayer';
import { UNKNOWN_VIDEO_IDENTITY, type VideoIdentity } from '@/utils/videoIdentity';

import type { VideoIdentityAdapter, VideoIdentityContext } from '@/entrypoints/content/video/identity/identityResolver';

const YOUTUBE_KEY_PREFIX = 'yt:';

const isYouTubeKey = (key: unknown): key is string => typeof key === 'string' && key.startsWith(YOUTUBE_KEY_PREFIX);

const parseClaim = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

const claimedIdentity = (claim: unknown): VideoIdentity => {
  const identity: unknown = claim && typeof claim === 'object' ? Reflect.get(claim, 'identity') : null;
  if (!identity || typeof identity !== 'object') return UNKNOWN_VIDEO_IDENTITY;
  const { kind, key, durationSec, pendingKey } = identity as Record<string, unknown>;
  if (kind === 'stable' && isYouTubeKey(key) && typeof durationSec === 'number' && durationSec > 0) {
    return { kind, key, durationSec };
  }
  if (kind === 'unknown' && isYouTubeKey(pendingKey)) return { kind, pendingKey };
  return UNKNOWN_VIDEO_IDENTITY;
};

/**
 * Reads the identity the MAIN-world MSE hook established for the `MediaSource` this video plays; the
 * page URL never identifies YouTube media, so a source without a matching claim stays unknown.
 */
function resolveYouTubeIdentity({ sourceUrl, video }: VideoIdentityContext): VideoIdentity | null {
  if (!sourceUrl.startsWith('blob:')) return null;
  const raw = video?.getAttribute(HOOK_IDENTITY_ATTR);
  const claim = raw ? parseClaim(raw) : null;
  if (!claim || typeof claim !== 'object' || Reflect.get(claim, 'objectUrl') !== sourceUrl) {
    return UNKNOWN_VIDEO_IDENTITY;
  }
  return claimedIdentity(claim);
}

export const youTubeIdentityAdapter: VideoIdentityAdapter = {
  matches: location => YOUTUBE_HOST.test(location.hostname),
  resolve: resolveYouTubeIdentity,
};
