import { tryParseUrl } from '@/utils/url';

export const SAME_DURATION_TOLERANCE_SEC = 1;
export const IDENTITY_WAIT_MS = 3_000;

export type PersistentIdentityKind = 'stable' | 'local';
export type VideoIdentityKind = PersistentIdentityKind | 'unknown';

/**
 * A video identity the persistent verdict cache may key by: `stable` names the media portably
 * (`namespace:id`), `local` only on this device (page plus duration). Its duration lets the cache
 * notice that the media behind a key changed.
 */
export interface PersistentVideoIdentity {
  kind: PersistentIdentityKind;
  key: string;
  durationSec: number;
}

/**
 * Media that could not be identified (yet): analysed and masked in memory only, never read from or
 * written to the persistent verdict cache. `pendingKey` names the identity it is expected to settle
 * on once a check that needs more of the media (its duration) passes.
 */
export interface UnknownVideoIdentity {
  kind: 'unknown';
  pendingKey?: string;
}

export type VideoIdentity = PersistentVideoIdentity | UnknownVideoIdentity;

export const UNKNOWN_VIDEO_IDENTITY: UnknownVideoIdentity = { kind: 'unknown' };

export type StableIdentityNamespace = 'yt' | 'vreddit' | 'redditpreview' | 'url';

const LOCAL_PAGE_NAMESPACE = 'page';
const DURATION_KEY_STEP_SEC = 0.1;

export const isKnownDuration = (durationSec: number): boolean => Number.isFinite(durationSec) && durationSec > 0;

export const stableIdentityKey = (namespace: StableIdentityNamespace, id: string): string => `${namespace}:${id}`;

export const isKeyInNamespace = (key: unknown, namespace: StableIdentityNamespace): key is string =>
  typeof key === 'string' && key.startsWith(`${namespace}:`);

export const stableIdentity = (
  namespace: StableIdentityNamespace,
  id: string,
  durationSec: number,
): PersistentVideoIdentity => ({ kind: 'stable', key: stableIdentityKey(namespace, id), durationSec });

function withoutFragment(href: string): string {
  const url = tryParseUrl(href);
  if (!url) return href;
  url.hash = '';
  return url.href;
}

export const localPageIdentity = (pageHref: string, durationSec: number): PersistentVideoIdentity => ({
  kind: 'local',
  key: `${LOCAL_PAGE_NAMESPACE}:${withoutFragment(pageHref)}|d=${Math.round(durationSec / DURATION_KEY_STEP_SEC)}`,
  durationSec,
});

export function videoIdentityFrom(value: unknown): VideoIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const { kind, key, durationSec, pendingKey } = value as Record<string, unknown>;
  if ((kind === 'stable' || kind === 'local') && typeof key === 'string' && typeof durationSec === 'number') {
    return isKnownDuration(durationSec) ? { kind, key, durationSec } : null;
  }
  if (kind !== 'unknown') return null;
  return typeof pendingKey === 'string' ? { kind, pendingKey } : UNKNOWN_VIDEO_IDENTITY;
}

export const isPersistentIdentity = (identity: VideoIdentity): identity is PersistentVideoIdentity =>
  identity.kind !== 'unknown';

export const persistentKeyOf = (identity: VideoIdentity): string | null =>
  isPersistentIdentity(identity) ? identity.key : null;

export const isSameMedia = (known: VideoIdentity, next: VideoIdentity): boolean =>
  isPersistentIdentity(known) && isPersistentIdentity(next) && known.key === next.key;

export const isPendingSameMedia = (known: VideoIdentity, next: VideoIdentity): boolean =>
  isPersistentIdentity(known) && next.kind === 'unknown' && next.pendingKey === known.key;

export const isDurationMismatch = (storedSec: number | undefined, identity: PersistentVideoIdentity): boolean =>
  storedSec !== undefined && Math.abs(storedSec - identity.durationSec) > SAME_DURATION_TOLERANCE_SEC;
