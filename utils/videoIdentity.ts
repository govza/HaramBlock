import { tryParseUrl } from '@/utils/url';

import type {
  IPersistentVideoIdentity,
  IStableMediaReference,
  IUnknownVideoIdentity,
  MediaReference,
  StableIdentityNamespace,
  VideoIdentity,
} from '@/utils/types/videoIdentity';

export const SAME_DURATION_TOLERANCE_SEC = 1;
export const IDENTITY_WAIT_MS = 3_000;

export const UNKNOWN_VIDEO_IDENTITY: IUnknownVideoIdentity = { kind: 'unknown' };

const STABLE_IDENTITY_NAMESPACES: Record<StableIdentityNamespace, true> = {
  yt: true,
  vreddit: true,
  redditpreview: true,
  url: true,
};

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

const localPageIdentity = (pageHref: string, durationSec: number): IPersistentVideoIdentity => ({
  kind: 'local',
  key: `${LOCAL_PAGE_NAMESPACE}:${withoutFragment(pageHref)}|d=${Math.round(durationSec / DURATION_KEY_STEP_SEC)}`,
  durationSec,
});

const matchesExpectedDuration = ({ expectedDurationSec }: IStableMediaReference, durationSec: number): boolean =>
  expectedDurationSec === undefined || Math.abs(durationSec - expectedDurationSec) <= SAME_DURATION_TOLERANCE_SEC;

function stableIdentityOf(reference: IStableMediaReference, durationSec: number): VideoIdentity {
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
  typeof value === 'string' && Object.hasOwn(STABLE_IDENTITY_NAMESPACES, value);

export function mediaReferenceFrom(value: unknown): MediaReference | null {
  if (!value || typeof value !== 'object') return null;
  const { kind, namespace, id, expectedDurationSec } = value as Record<string, unknown>;
  if (kind === 'local' || kind === 'unidentifiable') return { kind };
  if (kind !== 'stable' || !isStableIdentityNamespace(namespace) || typeof id !== 'string' || !id) return null;
  if (expectedDurationSec === undefined) return { kind, namespace, id };
  return typeof expectedDurationSec === 'number' ? { kind, namespace, id, expectedDurationSec } : null;
}

export const isPersistentIdentity = (identity: VideoIdentity): identity is IPersistentVideoIdentity =>
  identity.kind !== 'unknown';

export const persistentKeyOf = (identity: VideoIdentity): string | null =>
  isPersistentIdentity(identity) ? identity.key : null;

export const isSameMedia = (known: VideoIdentity, next: VideoIdentity): boolean =>
  isPersistentIdentity(known) && isPersistentIdentity(next) && known.key === next.key;

export const isPendingSameMedia = (known: VideoIdentity, next: VideoIdentity): boolean =>
  isPersistentIdentity(known) && next.kind === 'unknown' && next.pendingKey === known.key;

export const isDurationMismatch = (storedSec: number | undefined, identity: IPersistentVideoIdentity): boolean =>
  storedSec !== undefined && Math.abs(storedSec - identity.durationSec) > SAME_DURATION_TOLERANCE_SEC;
