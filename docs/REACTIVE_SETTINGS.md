# Settings & Storage (HostSettings)

HaramBlock stores per-site and global settings in IndexedDB (via Dexie) and exposes them to the UI
reactively (via `dexie-react-hooks`).

## What Is a HostSetting?

For each “effective hostname”, HaramBlock stores an `IHostSettings` row. There is also a single
global row keyed by `DEFAULT_GLOBAL_KEY` (used as defaults and for “global mode” in the UI).

## Data Model

Defined in `utils/types/host.ts`:

```ts
export type PolicyBehavior = 'whitelist' | 'blacklist' | 'process';
export type PolicyTarget = 'image' | 'video';
export type OutlineType = 'bbox' | 'segment';

export interface IMaskingSettings {
  grayscale: boolean;
  dark: boolean;
  blurIntensity: number; // 1-100%
  pixelationScale: number; // 1-100%
}

export interface IHostPolicy {
  behavior: PolicyBehavior; // single-select mode
  targets: Record<PolicyTarget, boolean>; // which media types are filtered when processing
}

export interface IHostSettings {
  hostname: string;
  isGlobal: boolean;
  masking: IMaskingSettings;
  outline: OutlineType;
  policy: IHostPolicy;
  strictness: number;
  minSize: { width: number; height: number };
  quickToggle: { unsafeEnabled: boolean; safeEnabled: boolean };
}
```

- `policy.behavior`
  - `whitelist`: don't filter
  - `blacklist`: filter everything (no inference)
  - `process`: run inference and filter based on predictions
- `policy.targets`: when `behavior` is `process`, which media types are filtered (`image`, `video`).
  Stored nested; read directly (`policy.targets.image`). `normalizeStoredPolicy` (`utils/policy.ts`)
  migrates legacy string policies (incl. the removed `process-images`) on read.
- `outline`: how the masking is applied (`bbox` or `segment`)
- `masking`: visual effects (grayscale, dark, blurIntensity, pixelationScale)
- `strictness`: detection threshold (higher = stricter)
- `minSize`: ignore very small media to reduce false positives and cost

## Hostname Normalization

Hostnames are normalized with `getEffectiveHostname()` (`utils/hostnameUtil.ts`). This is the key
used for settings lookup and for filtering prediction broadcasts.

## Storage (IndexedDB via Dexie)

- Database: `utils/db/db.ts`
- Table: `hostSettings` keyed by `hostname`
- Initial populate: inserts default global settings on first run

## Repositories (Write APIs)

Most UI code writes settings through repositories rather than calling Dexie directly:

- `HostSettingsRepository`: `utils/db/hostSettingsRepository.ts`
- `ImageCacheRepository`: `utils/db/imageCacheRepository.ts` (cached inference results)

## UI Reactivity (Popup / Options)

The popup/options UIs use a small stack of hooks + context:

- `useHostname()`: `hooks/useHostname.ts` (current tab hostname detection)
- `HostDataProvider`: `entrypoints/popup/context/HostDataContext.tsx`
  - uses `useLiveQuery` directly for reactive settings
  - combines hostname + settings and exposes:
    - `hostSettings`, `currentHostname`, `hostSettingsRepository`, `imageCacheRepository`
    - global/local mode helpers: `switchToGlobal()`, `switchToLocal()`, `isGlobalMode`

Minimal usage:

```tsx
import { HostDataProvider, useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';

export function App() {
  return (
    <HostDataProvider>
      <Popup />
    </HostDataProvider>
  );
}

function Popup() {
  const { hostSettings, hostSettingsRepository, isLoading } = useHostDataContext();
  if (isLoading) return null;
  return (
    <button onClick={() => void hostSettingsRepository.togglePolicy(hostSettings.hostname)}>
      Toggle Policy
    </button>
  );
}
```

## Content Script Initialization (Non-React)

The content script is not a React app. On each page load it fetches the host settings and cached
predictions from the background:

- `entrypoints/content/hooks/useHostData.ts`

It also subscribes to host-settings updates; when settings change, the page is reloaded so the
content script restarts with a clean state.
