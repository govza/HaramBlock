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
