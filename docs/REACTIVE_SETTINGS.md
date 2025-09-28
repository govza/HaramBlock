# Host Settings: IndexedDB Storage, Reactivity, and Hooks

This extension uses **Dexie** (a wrapper for IndexedDB) to store and manage per-host and global
settings. All settings are accessed and updated reactively in your UI using custom React hooks
powered by `dexie-react-hooks`.

## How HostSettings Work

### 1. Data Model

- **HostSettings** are objects representing configuration for a specific hostname or for global
  defaults.
- Each HostSettings object includes:
  - `hostname`: The domain or 'global' for default settings
  - `isGlobal`: Boolean, true for global settings
  - `masks`: Array of mask types (e.g. 'blur', 'pixelate')
  - `outline`: Outline type (e.g. 'bbox', 'segment')
  - `policy`: Policy type ('whitelist', 'blacklist', 'process')
  - `strictness`: Numeric value for filtering strictness

### 2. Storage: IndexedDB via Dexie

- All HostSettings are stored in the browser's **IndexedDB** using the **Dexie** library.
- Dexie provides a simple API for CRUD operations and schema management.
- The database is initialized with a default global settings object.
- Each HostSettings entry is keyed by its `hostname`.

**Example Dexie setup:**

```typescript
import Dexie from 'dexie';
import { DEFAULT_HOST_SETTINGS, IHostSettings } from './HostSettings';

export class HostSettingsDatabase extends Dexie {
  hostSettings!: Dexie.Table<IHostSettings, string>;
  constructor() {
    super('HostSettingsDatabase');
    this.version(1).stores({ hostSettings: 'hostname' });
  }
}
export const hostSettingsDb = new HostSettingsDatabase();
hostSettingsDb.on('populate', () => {
  hostSettingsDb.hostSettings.add(DEFAULT_HOST_SETTINGS);
});
```

### 3. Reactivity: Dexie + React Hooks

- **Reactivity** is achieved using `dexie-react-hooks`, specifically the `useLiveQuery` hook.
- Any changes to HostSettings in IndexedDB automatically update all subscribed React components.
- No manual refresh or polling is needed—UI updates instantly when data changes.

**Example reactive hook:**

```typescript
import { useLiveQuery } from 'dexie-react-hooks';
import { hostSettingsDb } from './db';

const hostSettings = useLiveQuery(
  () => hostSettingsDb.hostSettings.get('example.com'),
  ['example.com']
);
```

## Features

## HostSettings React Hooks & Context

### Hooks

The system now uses two focused hooks for better clarity and separation of concerns:

- **`useHostname()`**
  - **Hostname detection hook** for current tab hostname detection
  - Automatically detects current tab hostname from the browser
  - Returns current hostname and error state
  - No parameters needed - always works in auto-detection mode

- **`useHostSettings(hostname: string)`**
  - **Settings data hook** for loading and managing HostSettings for a specific hostname
  - Takes a hostname parameter (required) and loads settings for that hostname
  - Returns reactive HostSettings object and loading state
  - Automatically creates default settings if none exist
  - All data is reactive and auto-updates when changed

### Context Provider

- **`HostDataProvider`**
  - Combines both hooks to provide a unified interface
  - Uses `useHostname()` for hostname detection and `useHostSettings()` for data
  - Wrap your app or popup in this provider to make host settings available everywhere
  - All consumers update automatically when settings change

**Context Properties:**

- `hostSettings`: Current reactive host settings (automatically global or host-specific based on
  hostname)
- `currentHostname`: Current hostname being tracked
- `isLoading`: Loading state indicator
- `error`: Error message (if any)

**Note:** Use `hostSettings.isGlobal` to check if the current settings are global or host-specific.

### Usage Example

```tsx
import { HostDataProvider, useHostDataContext } from './context/HostDataContext';

function App() {
  return (
    <HostDataProvider>
      <YourComponent />
    </HostDataProvider>
  );
}

function YourComponent() {
  const { hostSettings, currentHostname } = useHostDataContext();
  return (
    <div>
      <p>Current Host: {currentHostname}</p>
      <p>Policy: {hostSettings.policy}</p>
      <p>Is Global: {hostSettings.isGlobal ? 'Yes' : 'No'}</p>
    </div>
  );
}
```

## Usage Examples

### Basic Usage

```tsx
import { HostDataProvider, useHostDataContext } from './context/HostDataContext';

function App() {
  return (
    <HostDataProvider>
      <YourComponent />
    </HostDataProvider>
  );
}

function YourComponent() {
  const { hostSettings } = useHostDataContext();

  const handleUpdate = async () => {
    await hostSettings.togglePolicy();
    // Component automatically re-renders - no manual refresh needed!
  };

  return (
    <div>
      <p>Current policy: {hostSettings.policy}</p>
      <button onClick={handleUpdate}>Toggle Policy</button>
    </div>
  );
}
```

### Advanced Usage

```tsx
import { HostDataProvider, useHostDataContext } from './context/HostDataContext';

function App() {
  return (
    <HostDataProvider>
      <YourComponent />
    </HostDataProvider>
  );
}

function YourComponent() {
  const { hostSettings, currentHostname } = useHostDataContext();

  return (
    <div>
      <p>Current Host: {currentHostname}</p>
      <p>Using global settings: {hostSettings.isGlobal ? 'Yes' : 'No'}</p>
      <p>Current policy: {hostSettings.policy}</p>
    </div>
  );
}
```

### Direct Hook Usage

```tsx
import { useHostname } from '@/hooks/useHostname';
import { useHostSettings } from '@/hooks/useHostSettings';

// Using both hooks separately for maximum control
function DetailedHostSettings() {
  const { currentHostname } = useHostname();
  const { hostSettings, isLoading } = useHostSettings(currentHostname);

  if (isLoading) return <div>Loading...</div>;

  return (
    <div>
      <p>Current hostname: {currentHostname}</p>
      <p>Using global: {hostSettings.isGlobal ? 'Yes' : 'No'}</p>
      <p>Settings policy: {hostSettings.policy}</p>
    </div>
  );
}

// Using just the settings hook for a specific hostname
function SpecificHostSettings() {
  const { hostSettings, isLoading } = useHostSettings('example.com');

  if (isLoading) return <div>Loading...</div>;

  return (
    <div>
      <p>Settings for example.com: {hostSettings.policy}</p>
    </div>
  );
}
```

### Error Handling

The reactive hooks handle errors gracefully and provide error states when needed. The `useLiveQuery`
hook will return `undefined` while loading and the actual data when ready.

## Dependencies

- `dexie`: ^4.0.11
- `dexie-react-hooks`: ^1.1.7
- `react`: ^19.1.0
