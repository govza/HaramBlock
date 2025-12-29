# Quick Toggle Feature

Per-image masking toggle that allows users to quickly disable or enable masking on individual
images.

## User Story

As a user, I want to quickly unmask a specific image without changing site-wide settings, so I can
view content I deem appropriate while keeping protection active for other images.

## Behavior

### Toggle Button

- SVG eye button appears on **hover** over registered images
- Positioned in top-right corner of the image (fixed position, follows viewport)
- Semi-transparent background (`rgba(0, 0, 0, 0.6)`), auto-hides after 2.5s
- Icon shows the **next state** (what clicking will do)

### Toggle States (3-state cycle)

- **null** (AI decides): Uses prediction overlays if unsafe, shows image if safe
- **'visible'** (force show): Image always visible, no overlays
- **'blocked'** (force hide): Image always blurred with blacklist overlay

Cycle differs based on image type:

- **Unsafe images** (has predictions): `null (blocked) → 'visible' → 'blocked' → null`
- **Safe images** (no predictions): `null (visible) → 'blocked' → 'visible' → null`

### Icons

Icon shows the next state that will be applied on click:

**Unsafe images:**

- Current `null` → shows open eye (next: visible)
- Current `'visible'` → shows closed eye (next: blocked)
- Current `'blocked'` → shows eye with checkmark (next: AI decides)

**Safe images:**

- Current `null` → shows closed eye (next: blocked)
- Current `'blocked'` → shows open eye (next: visible)
- Current `'visible'` → shows eye with checkmark (next: AI decides)

Icons shared via `@/components/ui/icons.ts`:

- `EYE_VISIBLE_PATH` - open eye icon
- `EYE_BLOCKED_PATH` - eye with slash icon
- `EYE_AUTO_PATH` - eye with checkmark icon

### Persistence

- Toggle state stored in `IImagePrediction.forcedVisibility` field (`null | 'visible' | 'blocked'`)
- Persists in IndexedDB cache via `ImageCacheService.updateToggleState()`
- Multiple images with same `src` share toggle state
- Use `shouldBlock(prediction)` helper to determine if image should be blocked

## Host Settings

The quick toggle can be enabled/disabled per-host via popup settings, with separate controls for
unsafe (masked) and safe (unmasked) images.

### Data Model

```typescript
interface IHostSettings {
  // ... existing fields ...
  quickToggle: {
    unsafeEnabled: boolean; // Show toggle on images WITH predictions (masked)
    safeEnabled: boolean; // Show toggle on images WITHOUT predictions (safe)
  };
}
```

Defaults: `unsafeEnabled: true`, `safeEnabled: false`

### Popup UI

Two switch toggles in popup (`QuickToggleSetting.tsx`):

- **Unsafe**: Toggle for masked images (has predictions)
- **Safe**: Toggle for safe images (no predictions)

Disabled when `policy !== 'process'`.

## Technical Implementation

### Per-Image State

```typescript
interface IImagePrediction {
  // ... existing fields ...
  forcedVisibility: null | 'visible' | 'blocked';
}

// Helper function to determine blocking
function shouldBlock(prediction: IImagePrediction): boolean {
  if (prediction.forcedVisibility === 'visible') return false;
  if (prediction.forcedVisibility === 'blocked') return true;
  return Boolean(prediction.predictions?.length);
}
```

### Components

| File                                                   | Purpose                                           |
| ------------------------------------------------------ | ------------------------------------------------- |
| `components/ui/icons.ts`                               | Shared SVG icon paths                             |
| `entrypoints/content/presentation/quickToggle.ts`      | Global button, hover tracking, state management   |
| `entrypoints/content/core/ImageProcessor.ts`           | Handles toggle callback, applies visibility state |
| `entrypoints/content/presentation/boundingBox.ts`      | Integration - uses shouldBlock for rendering      |
| `entrypoints/content/presentation/imageMaskOverlay.ts` | Integration - uses shouldBlock for rendering      |
| `entrypoints/background/services/imageCacheService.ts` | `updateToggleState()` persists state to IndexedDB |
| `entrypoints/popup/components/QuickToggleSetting.tsx`  | Popup UI for host settings                        |

### Exported API (`quickToggle.ts`)

```typescript
// Initialize with callback for state changes
initQuickToggle(onToggle: (src: string, forcedVisibility: ForcedVisibility) => void): void

// Register element for hover tracking
registerQuickToggle(
  element: HTMLImageElement | HTMLVideoElement,
  prediction: IImagePrediction,
  quickToggle: { unsafeEnabled: boolean; safeEnabled: boolean }
): void

// Remove element from tracking
unregisterQuickToggle(element: HTMLImageElement | HTMLVideoElement): void

// Update prediction reference for registered element
updateQuickTogglePrediction(
  element: HTMLImageElement | HTMLVideoElement,
  prediction: IImagePrediction
): void

// Check if element is registered
isElementRegistered(element: HTMLImageElement | HTMLVideoElement): boolean
```

### CSS Styling

```css
.haramblock-eye-toggle {
  width: 2rem;
  height: 2rem;
  padding: 0.25rem;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  cursor: pointer;
  z-index: 100000000;
}
```

## i18n Keys

```
HostSettings.QuickToggle.unsafe = "Show eye toggle on blocked media"
HostSettings.QuickToggle.safe = "Show eye toggle on allowed media"
```
