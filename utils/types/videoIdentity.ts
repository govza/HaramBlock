export type PersistentIdentityKind = 'stable' | 'local';
export type VideoIdentityKind = PersistentIdentityKind | 'unknown';

/**
 * A video identity the persistent verdict cache may key by: `stable` names the media portably
 * (`namespace:id`), `local` only on this device (page plus duration). Its duration lets the cache
 * notice that the media behind a key changed.
 */
export interface IPersistentVideoIdentity {
  kind: PersistentIdentityKind;
  key: string;
  durationSec: number;
}

/**
 * Media that could not be identified (yet): analysed and masked in memory only, never read from or
 * written to the persistent verdict cache. `pendingKey` names the identity it is expected to settle
 * on once a check that needs more of the media (its duration) passes.
 */
export interface IUnknownVideoIdentity {
  kind: 'unknown';
  pendingKey?: string;
}

export type VideoIdentity = IPersistentVideoIdentity | IUnknownVideoIdentity;

export type StableIdentityNamespace = 'yt' | 'vreddit' | 'redditpreview' | 'url';

/**
 * Media a site adapter or the generic rules name portably, across pages and renditions: the
 * Identity resolver keys it `namespace:id` once the media's duration is known, and only if that
 * duration matches the length the site itself reports for it, when it reports one.
 */
export interface IStableMediaReference {
  kind: 'stable';
  namespace: StableIdentityNamespace;
  id: string;
  expectedDurationSec?: number;
}

export type MediaReference = IStableMediaReference | { kind: 'local' } | { kind: 'unidentifiable' };
