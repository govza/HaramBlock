# Quick Toggle Feature

Per-image masking toggle that allows users to quickly disable or enable masking on individual
images.

> **Note:** Quick Toggle currently only works with images. Video support is not yet implemented.

## TODO: Video Support

Video toggle applies to the entire video element (not per-frame). Requires video prediction caching
first:

- [ ] Add video prediction cache with `forcedVisibility` per video URL
- [ ] Update `quickToggle.ts` types to accept `HTMLImageElement | HTMLVideoElement`
- [ ] Add `registerQuickToggle()` calls in `videoPredictions.ts`
- [ ] Create video toggle handler to show/hide all frame overlays
- [ ] Add cleanup in `handleVideos.ts` via `unregisterQuickToggle()`

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

Cycle is the same for both image types:

- **Unsafe images** (has predictions): `null (blocked) → 'blocked' → 'visible' → null`
- **Safe images** (no predictions): `null (visible) → 'blocked' → 'visible' → null`

### Icons

Icon shows the next state that will be applied on click:

**Both unsafe and safe images:**

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

// Register image for hover tracking
registerQuickToggle(
  element: HTMLImageElement,
  prediction: IImagePrediction,
  quickToggle: { unsafeEnabled: boolean; safeEnabled: boolean }
): void

// Remove image from tracking
unregisterQuickToggle(element: HTMLImageElement): void

// Update prediction reference for registered image
updateQuickTogglePrediction(
  element: HTMLImageElement,
  prediction: IImagePrediction
): void

// Check if image is registered
isElementRegistered(element: HTMLImageElement): boolean
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
