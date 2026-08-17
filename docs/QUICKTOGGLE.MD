# Quick Toggle Feature

Per-media masking toggle that allows users to quickly disable or enable masking on individual
images and videos.

## Video Support

Videos share the same eye button, 3-state cycle, and host switches as images, but their toggle
state is **session-scoped, never persisted**:

- State lives in the `VideoSessionRegistry` per (element × resolved source). A source change
  drops the override; two elements playing the same URL toggle independently. This also makes
  blob:/MSE sources (YouTube) work — no stable URL is needed.
- `'visible'` is fully hands-off: the VideoSession is disposed (no sampling, no inference, no
  DVR, no audio delay). Returning to `'auto'` re-adopts the video for a fresh verdict.
- `'blocked'` disposes the session and applies the blacklist-style whole-video mask.
- Entry point: `videoSessions.setForcedVisibility(video, next)` — wired as the registration's
  per-element `onToggle`, since there is no src-keyed store to route through. Forced videos
  keep a `loadstart`/`emptied` listener so a new source re-enters normal adoption.
- The button registers at adoption (safe switch), re-registers on each status flip
  (safe ↔ unsafe switch), and stays available on forced videos while either switch is on.

## User Story

As a user, I want to quickly unmask a specific image without changing site-wide settings, so I can
view content I deem appropriate while keeping protection active for other images.

## Behavior

### Toggle Button

- SVG eye button appears on **hover** (desktop) or **tap** (mobile) over registered media
- Uses pointer events (`pointerenter`/`pointerleave`) so each mobile tap fires fresh — avoids the synthetic-mouse sticky-hover bug where a second tap on the same image would not re-trigger the button
- A single global button that is inserted into the hovered image's parent (absolute position, like
  the mask overlay), anchored at the top-right of the **rendered content rect** — the visible
  picture, not the element box, so letterbox bars in contain-fit lightboxes never get the button.
  The rect is clipped to the element box first: cover-fit crop overflow is never visible, and an
  `overflow: hidden` parent would clip a button anchored past the box into an unclickable sliver
- Stacked just above its image (image z-index + 2, one step above the mask overlay's + 1) — never
  a large fixed z-index, so a lightbox backdrop that covers the image also covers the button, and
  scrolling moves both together (no hide-on-scroll)
- After showing, the button center is hit-tested (`elementFromPoint`); if site chrome wins the hit
  (e.g. a transparent sticky banner with a high z-index), the button's z-index is raised just above
  that occluder's stacking chain. When z-index cannot win — the occluder lives in a sibling
  stacking context above the button's (e.g. a sticky banner over a transformed scroll container) —
  the z is restored and the button slides below the occluder instead, as long as it stays on the
  media. Lightbox backdrops still cover the button: an occluder over the media's center that
  extends well beyond the media (2x its area) marks the media as covered and skips the lift —
  while a same-size cover (stretched link or caption overlay) still gets it. Never a blanket
  large z-index
- The button's chrome is inline styles (the injected class rules cannot reach shadow trees); the
  `.haramblock-eye-toggle` class remains for hover styling and test selectors
- Semi-transparent background (`rgba(0, 0, 0, 0.5)`), auto-hides after 2.5s
- **White (inverted) background** when the pipeline finalized the element without
  analyzing it (video `skipped` status, e.g. an undelayable cross-origin source) and no override
  is active — the user can tell "AI-verified safe" from "never checked" and force-block from there.
  Unprocessed elements use a 2-state cycle (`auto ↔ blocked`): `visible` would just restate the
  already-unprotected `auto`
- Icon shows the **next state** (what clicking will do)

### Toggle States (3-state cycle)

- **'auto'** (AI decides): Uses prediction overlays if unsafe, shows image if safe
- **'visible'** (force show): Image always visible, no overlays
- **'blocked'** (force hide): Image always blurred with blacklist overlay

Cycle is the same for both image types:

- **Unsafe images** (has predictions): `'auto' (blocked) → 'blocked' → 'visible' → 'auto'`
- **Safe images** (no predictions): `'auto' (visible) → 'blocked' → 'visible' → 'auto'`

### Icons

Icon shows the next state that will be applied on click:

**Both unsafe and safe images:**

- Current `'auto'` → shows closed eye (next: blocked)
- Current `'blocked'` → shows open eye (next: visible)
- Current `'visible'` → shows eye with checkmark (next: AI decides)

Icons shared via `@/components/ui/icons.ts`:

- `EYE_VISIBLE_PATH` - open eye icon
- `EYE_BLOCKED_PATH` - eye with slash icon
- `EYE_AUTO_PATH` - eye with checkmark icon

### Persistence

- Toggle state stored in `IImagePrediction.forcedVisibility` field (`'auto' | 'visible' | 'blocked'`)
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

Defaults: `unsafeEnabled: true`, `safeEnabled: true`

### Popup UI

Two switch toggles in popup (`QuickToggleSetting.tsx`):

- **Unsafe**: Toggle for masked images (has predictions)
- **Safe**: Toggle for safe images (no predictions)

Disabled when `policy.behavior !== 'process'`.

## Technical Implementation

### Per-Image State

```typescript
interface IImagePrediction {
  // ... existing fields ...
  forcedVisibility: 'auto' | 'visible' | 'blocked';
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
// Initialize with the global src-keyed callback for state changes
initQuickToggle(onToggle: (src: string, forcedVisibility: ForcedVisibility) => void): void

// Register an image or video for hover tracking. onToggle (per-element handler,
// used by videos) bypasses the global callback. predictionToggleRegistration()
// builds this options object from an IImagePrediction.
registerQuickToggle(element: HTMLImageElement | HTMLVideoElement, opts: {
  src: string;
  forcedVisibility: ForcedVisibility;
  hasDetections: boolean;
  hostSettings: IHostSettings;
  onToggle?: (next: ForcedVisibility) => void;
}): void

// Remove element from tracking
unregisterQuickToggle(element: HTMLImageElement | HTMLVideoElement): void
```

### Styling

The button's core chrome (px-based size, absolute position, background) is set as inline styles at
creation, because the button is inserted into arbitrary site parents — possibly inside shadow trees
where the document-level `.haramblock-eye-toggle` rules never apply. Its z-index is computed per
show (image z-index + 2). The injected class rule only carries the hover effect for light-DOM
cases; the class name doubles as the e2e test selector.

## i18n Keys

```
HostSettings.QuickToggle.unsafe = "Show eye toggle on blocked media"
HostSettings.QuickToggle.safe = "Show eye toggle on allowed media"
```
