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

const STABLE_IDENTITY_NAMESPACES = ['yt', 'vreddit', 'redditpreview', 'url'] as const;

export type StableIdentityNamespace = (typeof STABLE_IDENTITY_NAMESPACES)[number];

/**
 * Media a site adapter or the generic rules name portably, across pages and renditions: the
 * Identity resolver keys it `namespace:id` once the media's duration is known, and only if that
 * duration matches the length the site itself reports for it, when it reports one.
 */
export interface StableMediaReference {
  kind: 'stable';
  namespace: StableIdentityNamespace;
  id: string;
  expectedDurationSec?: number;
}

export type MediaReference = StableMediaReference | { kind: 'local' } | { kind: 'unidentifiable' };

export const LOCAL_MEDIA_REFERENCE: MediaReference = { kind: 'local' };
export const UNIDENTIFIABLE_MEDIA_REFERENCE: MediaReference = { kind: 'unidentifiable' };

const LOCAL_PAGE_NAMESPACE = 'page';
const DURATION_KEY_STEP_SEC = SAME_DURATION_TOLERANCE_SEC;

export const isKnownDuration = (durationSec: number): boolean => Number.isFinite(durationSec) && durationSec > 0;

export const stableIdentityKey = (namespace: StableIdentityNamespace, id: string): string => `${namespace}:${id}`;

function withoutFragment(href: string): string {
  const url = tryParseUrl(href);
  if (!url) return href;
  url.hash = '';
  return url.href;
}

const localPageIdentity = (pageHref: string, durationSec: number): PersistentVideoIdentity => ({
  kind: 'local',
  key: `${LOCAL_PAGE_NAMESPACE}:${withoutFragment(pageHref)}|d=${Math.round(durationSec / DURATION_KEY_STEP_SEC)}`,
  durationSec,
});

const matchesExpectedDuration = ({ expectedDurationSec }: StableMediaReference, durationSec: number): boolean =>
  expectedDurationSec === undefined || Math.abs(durationSec - expectedDurationSec) <= SAME_DURATION_TOLERANCE_SEC;

function stableIdentityOf(reference: StableMediaReference, durationSec: number): VideoIdentity {
  const key = stableIdentityKey(reference.namespace, reference.id);
  if (Number.isNaN(durationSec)) return { kind: 'unknown', pendingKey: key };
  if (!isKnownDuration(durationSec) || !matchesExpectedDuration(reference, durationSec)) return UNKNOWN_VIDEO_IDENTITY;
  return { kind: 'stable', key, durationSec };
}

export function identityOfMediaReference(
  reference: MediaReference,
  durationSec: number,
  pageHref: string,
): VideoIdentity {
  if (reference.kind === 'stable') return stableIdentityOf(reference, durationSec);
  if (reference.kind === 'local' && isKnownDuration(durationSec)) return localPageIdentity(pageHref, durationSec);
  return UNKNOWN_VIDEO_IDENTITY;
}

const isStableIdentityNamespace = (value: unknown): value is StableIdentityNamespace =>
  STABLE_IDENTITY_NAMESPACES.some(namespace => namespace === value);

export function mediaReferenceFrom(value: unknown): MediaReference | null {
  if (!value || typeof value !== 'object') return null;
  const { kind, namespace, id, expectedDurationSec } = value as Record<string, unknown>;
  if (kind === 'local' || kind === 'unidentifiable') return { kind };
  if (kind !== 'stable' || !isStableIdentityNamespace(namespace) || typeof id !== 'string' || !id) return null;
  if (expectedDurationSec === undefined) return { kind, namespace, id };
  return typeof expectedDurationSec === 'number' ? { kind, namespace, id, expectedDurationSec } : null;
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
