import { DEFAULT_HOST_SETTINGS } from '@/utils/constants';

import type { IHostPolicy, PolicyBehavior } from '@/utils/types';

const isBehavior = (value: unknown): value is PolicyBehavior =>
  value === 'whitelist' || value === 'blacklist' || value === 'process';

/**
 * Coerce a stored `policy` value into a valid {@link IHostPolicy}.
 * Legacy flat string policies and records saved before `targets` existed are migrated;
 * unrecognized values fall back to the default policy. `targets` are preserved as-is across
 * behaviors — they're only consulted under the `process` behavior, but a Process selection
 * must survive cycling through whitelist/blacklist.
 */
export const normalizeStoredPolicy = (raw: unknown): IHostPolicy => {
  const defaults = DEFAULT_HOST_SETTINGS.policy;

  if (typeof raw === 'string') {
    switch (raw) {
      case 'whitelist':
      case 'blacklist':
        return { behavior: raw, targets: { ...defaults.targets } };
      case 'process':
        return { behavior: 'process', targets: { image: true, gif: true, video: true } };
      default:
        return { behavior: defaults.behavior, targets: { ...defaults.targets } };
    }
  }

  if (raw && typeof raw === 'object') {
    const policy = raw as Partial<IHostPolicy>;
    return {
      behavior: isBehavior(policy.behavior) ? policy.behavior : defaults.behavior,
      targets: { ...defaults.targets, ...policy.targets },
    };
  }

  return { behavior: defaults.behavior, targets: { ...defaults.targets } };
};
