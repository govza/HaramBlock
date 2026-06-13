# Popup UI

The popup UI (`entrypoints/popup/`) is a React-based interface that appears when users click the
extension icon. It provides per-site and global settings controls for content filtering.

## Directory Structure

```
entrypoints/popup/
├── main.tsx                     # React entry point
├── App.tsx                      # Root component with context provider
├── index.html                   # HTML template
├── style.css                    # Global styles
├── context/
│   └── HostDataContext.tsx      # Global state management
├── layouts/
│   └── PopupLayout.tsx          # Main layout wrapper
└── components/
    ├── Header.tsx               # Header with hostname display
    ├── Content.tsx              # Settings container
    ├── FlipCard.tsx             # 3D flip animation for global/local toggle
    ├── HelpPanel.tsx            # Help and contact information panel
    ├── PerformanceStats.tsx     # Real-time performance statistics
    ├── PolicyButton.tsx         # Policy mode toggle
    ├── Strictness.tsx           # Detection threshold slider
    ├── Outline.tsx              # Visualization style toggle
    ├── BlurIntensity.tsx        # Blur strength slider
    ├── BlurTint.tsx             # Grayscale/dark toggles
    ├── PixelationScale.tsx      # Pixelation level slider
    ├── QuickToggleSetting.tsx   # Quick toggle switches
    └── footer/
        ├── Footer.tsx           # Footer container
        ├── AppVersion.tsx       # Version display
        ├── CopyLogsButton.tsx   # Export logs to clipboard
        ├── HelpToggle.tsx       # Toggle help panel
        ├── ModelToggle.tsx      # AI model selector
        └── OptionsIcon.tsx      # Open options page
```

## State Management

### HostDataContext

The `HostDataContext` is the central state provider for the popup. It manages:

- **Current hostname**: Auto-detected from the active tab via `useHostname()`
- **Host settings**: Loaded reactively from IndexedDB via `useLiveQuery`
- **Global/Local mode**: Toggle between site-specific and global settings
- **Repository access**: Provides `HostSettingsRepository` and `ImageCacheRepository`

```tsx
interface HostDataType {
  hostSettings: IHostSettings;
  currentHostname: string;
  isLoading: boolean;
  error?: string;
  hostSettingsRepository: HostSettingsRepository;
  imageCacheRepository: ImageCacheRepository;
  switchToGlobal: () => void;
  switchToLocal: () => void;
  isGlobalMode: boolean;
}
```

Usage:

```tsx
import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';

function MyComponent() {
  const { hostSettings, hostSettingsRepository } = useHostDataContext();

  const handleToggle = () => {
    void hostSettingsRepository.togglePolicy(hostSettings.hostname);
  };

  return <button onClick={handleToggle}>{hostSettings.policy}</button>;
}
```

## Core Components

### FlipCard

A compound component providing 3D card flip animation to toggle between site-specific (front) and
global (back) settings.

```tsx
<FlipCard isFlipped={isGlobalMode} onFlip={handleFlip}>
  <FlipCard.Front>
    <FlipCard.Header className='bg-secondary' />
    {/* Site-specific settings */}
  </FlipCard.Front>
  <FlipCard.Back>
    <FlipCard.Header className='bg-danger' />
    {/* Global settings */}
  </FlipCard.Back>
</FlipCard>
```

The header displays the hostname or "Global Settings" and shows a globe icon when in global mode.

### PolicyButton

Cycles through three filtering modes:

| Mode        | Icon        | Behavior                                         |
| ----------- | ----------- | ------------------------------------------------ |
| `whitelist` | Eye         | Allow all content (no filtering)                 |
| `blacklist` | Eye blocked | Block all content (no inference)                 |
| `process`   | Eye auto    | Run AI inference and filter based on predictions |

### Strictness

A slider controlling the AI detection confidence threshold (0-100%). Higher values require more
confidence before flagging content.

**Side effect**: Changing strictness clears the image cache for the current hostname, forcing
re-inference with the new threshold.

### Outline

Toggle between visualization styles:

- **bbox**: Bounding box outline (red rectangle around detected areas)
- **segment**: Pixel-perfect segmentation mask

### BlurIntensity / PixelationScale

These sliders control the masking intensity:

- **BlurIntensity**: Shown when `policy === 'blacklist'` OR `outline === 'bbox'`
- **PixelationScale**: Shown when `policy === 'process'` AND `outline === 'segment'`

### BlurTint

Toggles for additional visual effects on detected content:

- **Grayscale**: Convert detected areas to grayscale
- **Dark**: Darken detected areas

### QuickToggleSetting

Enable/disable quick toggle buttons that appear on images in the content script:

- **Unsafe toggle**: Show button to mark content as unsafe
- **Safe toggle**: Show button to mark content as safe

## HelpPanel & PerformanceStats

`HelpPanel` is a collapsible panel toggled by `HelpToggle` that displays:

1. **Help content**: Tooltip text and contact links (GitHub, Email, Website)
2. **PerformanceStats**: Embedded component showing real-time inference metrics

### PerformanceStats

Displays real-time performance statistics when the panel is open:

| Stat       | Description                          |
| ---------- | ------------------------------------ |
| Detections | Number of unsafe detections on total |
| Inference  | Median AI inference time (ms)        |
| Throughput | Images processed per second          |
| E2E        | Median end-to-end latency (ms)       |

- Data is fetched from `ImageCacheRepository` (global or per-hostname based on mode)
- Stats refresh every 2 seconds while the panel is active
- Polling stops when the panel is closed to save resources

## Footer Components

### OptionsIcon

Opens the extension's options page via `browser.runtime.openOptionsPage()`.

### ModelToggle

Cycles the model preference: `auto → model1 → model2 → … → auto` (skipping the model already
effective when leaving `auto`). Communicates with the background service worker via `backgroundRpc`:

```ts
backgroundRpc.getAvailableModels();
backgroundRpc.getModelPreference();
backgroundRpc.setModelPreference(preference); // 'auto' | model id
backgroundRpc.getEffectiveModelId();
```

The button shows a compact label — first letter of the model id plus its input size, so `sem-i320`
renders as `s320`. In auto mode it shows the effective model inline as `^auto - s320`; the `^` marks
that auto can still upgrade and is dropped (`auto - s640`) once the largest model is active.

### AppVersion

Displays the current extension version from `package.json`.

### HelpToggle

Toggles the `HelpPanel` visibility and syncs with console logging state. When opened, console
logging is enabled; when closed, it's disabled. The panel state is persisted across popup sessions
via `getLogSettings`/`setLogSettings`.

### CopyLogsButton

A `[logs]` text button that exports all logs to clipboard as JSON using `exportEventsAsJson()`.
Shows `[copied]` (green) or `[error]` (red) feedback for 2 seconds after click. Located inside
`HelpPanel`.

## Data Flow

```
User clicks extension icon
        ↓
main.tsx renders App
        ↓
HostDataProvider initializes
├─ useHostname() → detects current tab
├─ useLiveQuery() → fetches settings from IndexedDB
└─ provides context to all components
        ↓
FlipCard renders front/back sides
        ↓
Settings components (PolicyButton, Strictness, etc.)
├─ Read from context (hostSettings)
└─ Write via repository methods
        ↓
IndexedDB updates
        ↓
useLiveQuery re-renders components
```

## Styling

The popup uses Tailwind CSS with custom CSS variables for theming:

- `bg-surface`, `bg-secondary`, `bg-danger`, `bg-success` for backgrounds
- `text-primary`, `text-secondary` for text colors
- Dark mode support via `prefers-color-scheme`
- Min-width: 320px
- 3D transforms for FlipCard animations (500ms transition)

## Conditional Rendering Logic

Settings visibility depends on current policy and outline:

| Component          | Visible When                                       |
| ------------------ | -------------------------------------------------- |
| Strictness         | `policy !== 'whitelist'` (disabled otherwise)      |
| Outline            | `policy !== 'whitelist'`                           |
| BlurTint           | `policy !== 'whitelist'`                           |
| BlurIntensity      | `policy === 'blacklist'` OR `outline === 'bbox'`   |
| PixelationScale    | `policy === 'process'` AND `outline === 'segment'` |
| QuickToggleSetting | `policy !== 'whitelist'`                           |
