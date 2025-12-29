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

### Toggle States

- **Masked** (default): Eye with slash icon - image is blurred/masked
- **Unmasked**: Open eye icon - original image shown completely

### Interaction

- Click toggles between masked and unmasked states (bidirectional)
- When unmasked: all overlays removed, original image visible
- When masked: overlays re-applied based on predictions

### Persistence

- Toggle state stored in `IImagePrediction.isUnmasked` field
- Persists in IndexedDB cache via `ImageCacheService.updateToggleState()`
- Multiple images with same `src` share toggle state

## Host Settings

The quick toggle can be enabled/disabled per-host via popup settings, with separate controls for
unsafe (masked) and safe (unmasked) images.

### Data Model

```typescript
interface IHostSettings {
  // ... existing fields ...
  eyeToggle: {
    unsafeEnabled: boolean; // Show toggle on images WITH predictions (masked)
    safeEnabled: boolean; // Show toggle on images WITHOUT predictions (safe)
  };
}
```

Defaults: `unsafeEnabled: true`, `safeEnabled: false`

### Popup UI

Two switch toggles in popup (`EyeToggleSetting.tsx`):

- **Unsafe**: Toggle for masked images (has predictions)
- **Safe**: Toggle for safe images (no predictions)

Disabled when `policy !== 'process'`.

## Technical Implementation

### Per-Image State

```typescript
interface IImagePrediction {
  // ... existing fields ...
  isUnmasked: boolean; // User toggled masking off for this image
}
```

### Components

| File                                                   | Purpose                                                         |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| `entrypoints/content/presentation/eyeToggle.ts`        | Global button, hover tracking, state management                 |
| `entrypoints/content/presentation/boundingBox.ts`      | Integration - registers elements, skips rendering when unmasked |
| `entrypoints/content/presentation/imageMaskOverlay.ts` | Integration - registers elements, skips rendering when unmasked |
| `entrypoints/content/presentation/styleInjecting.ts`   | CSS for `.haramblock-eye-toggle` button                         |
| `entrypoints/background/services/imageCacheService.ts` | `updateToggleState()` persists state to IndexedDB               |
| `entrypoints/popup/components/EyeToggleSetting.tsx`    | Popup UI for host settings                                      |

### Exported API (`eyeToggle.ts`)

```typescript
// Initialize with callback for state changes
initEyeToggle(onToggle: (src: string, isUnmasked: boolean) => void): void

// Register element for hover tracking
registerEyeToggle(
  element: HTMLImageElement | HTMLVideoElement,
  prediction: IImagePrediction,
  eyeToggle: { unsafeEnabled: boolean; safeEnabled: boolean }
): void

// Remove element from tracking
unregisterEyeToggle(element: HTMLImageElement | HTMLVideoElement): void

// Update prediction reference for registered element
updateEyeTogglePrediction(
  element: HTMLImageElement | HTMLVideoElement,
  prediction: IImagePrediction
): void

// Check if element is registered
isElementRegistered(element: HTMLImageElement | HTMLVideoElement): boolean
```

### SVG Icons

Uses Material Design icons (same as popup Header.tsx):

- Eye open: `EYE_OPEN_PATH` - visibility icon
- Eye with slash: `EYE_CLOSED_PATH` - visibility off icon

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
HostSettings.EyeToggle.unsafe = "Show eye toggle on blocked media"
HostSettings.EyeToggle.safe = "Show eye toggle on allowed media"
```
