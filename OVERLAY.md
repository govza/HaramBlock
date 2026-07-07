# OVERLAY.md — Extension-owned overlay layer (devtools-style)

Working plan for moving all mask overlays out of site DOM into a single extension-owned,
viewport-anchored layer. Written to be self-sufficient: a fresh session should be able to continue
from here without prior context.

> **Status (2026-07-05):** Stages 0–3 are implemented on `feat/overlay-layer` (layer + tracker infra
> with unit tests, all three renderers migrated, quickToggle mounted in the layer, docs updated).
> Remaining from the plan: the Stage 1/2 **e2e scenarios** (nested-scroller alignment, React
> re-render, transform carousel, fullscreen) and real-page verification.

## 1. Where we are

Three presentation modules render masks today, all with the same **in-site-DOM sibling** pattern:

- `entrypoints/content/presentation/imageMaskOverlay.ts` — pixelated RLE-mask canvas for static
  images.
- `entrypoints/content/presentation/gifMaskPlayer.ts` — canvas replaying decoded GIF frames with
  per-frame masks.
- `entrypoints/content/presentation/videoMaskOverlay.ts` — segmentation mask canvas over videos.

Shared pattern (and its problems):

1. `if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative'` —
   mutates site CSS; can re-anchor the site's own absolutely-positioned children and break layouts.
2. Overlay `<div>` is appended as a child of the media element's parent. Framework reconciliation
   (React/Vue own that parent) can silently delete or duplicate the overlay on re-render.
3. Position is computed from `elementRect − parentRect` and updated only on ResizeObserver /
   window-resize. Carousels (CSS transforms), in-container scrolling, and layout shifts that don't
   resize the element leave the mask drifted off the content.
4. `z-index = element z-index + 1` — fragile across stacking contexts.
5. Each overlay carries its own ResizeObserver + a `MutationObserver` on `document.body`
   (`subtree: true`) for removal detection — N overlays = N subtree observers.

Precedent already in the codebase: the quick-toggle eye button (`presentation/quickToggle.ts`) is a
single `position: fixed` element appended to `document.body`, positioned from
`getBoundingClientRect()` — the exact pattern this plan generalizes.

Related plan: `VIDEO_PLAN.md` (DVR delayed presentation). The DVR canvas presenter
(`videoDvrPlayer`) should mount into this layer rather than inventing a fourth positioning scheme —
coordinate the two efforts (see §7).

### Dev-environment quirks (needed to build/test)

- `node` is not on PATH in non-interactive shells:
  `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"` before `pnpm`/`git commit`.
- Leftover worktrees pollute full runs; use `pnpm test:unit run --exclude '**/.claude/**'` and lint
  changed files explicitly.
- **No `Co-Authored-By: Claude` trailers on commits** (owner preference).

## 2. Target design

One extension-owned host per document (like the devtools element highlighter):

```
<haramblock-overlay-layer>          ← custom element, appended to document.documentElement;
                                      zero-size, no stacking context, pointer-events: none
  <div data-overlay-slot …>         ← one per tracked media element; position: fixed;
    <canvas …>                         top/left from anchor(); own z-index
  <div data-overlay-slot …>            (see "Per-slot stacking")
</haramblock-overlay-layer>
```

No shadow root on the mask host: anchor names are tree-scoped and engines do not resolve an
outer-tree `anchor-name` from inside a shadow root — slots must live in the document tree, so they
are shielded from site CSS by important-flagged inline styles instead of a shadow boundary (the UI
host keeps its shadow root).

Key properties:

- **CSS-anchor-positioned slots.** Each tracked element gets an inline
  `anchor-name: --haramblock-anchor-N !important`; its slot is placed with `position-anchor` +
  `top/left: anchor(..., 0px)`. The browser glues the slot to the element on the compositor thread —
  JS repositioning always runs a frame behind compositor scrolling — and it works through nested
  scrollers and for sticky anchors. JS writes only width/height and clip (scroll-invariant). The
  inline `anchor-name` is re-asserted on the 200 ms slow scan (`onSlowScan` hook) because framework
  re-renders rewrite style attributes, composed with the element's own anchor-name list (site
  anchored UI keeps working while masked), and restored on detach/dispose. No parent rect math, no
  `parent.style.position` mutation. Deliberately **no JS positioning fallback**: the manifest
  browser floors carry the requirement (Chrome/Edge 125, Firefox desktop+Android 147 per MDN BCD for
  `position-anchor`; the "partial" BCD notes concern only the property's initial value, which is
  always set explicitly here). Watch item: per spec, transform-based anchor movement (carousels) may
  lag a few frames or not track until re-layout — verify on a real carousel; if broken, add a
  per-sweep corrective transform only for entries with a transformed ancestor (the chainZ walk
  already reads `transform`).
- **Immune to site frameworks.** Nothing is injected next to the media element; React can re-render
  whatever it wants. Site CSS is kept out by important-flagged inline styles on slots/canvases (mask
  host) and by the shadow boundary (UI host).
- **Appended to `documentElement`, not `body`** — some sites replace `body` wholesale.
- **Works for shadow-DOM media for free** — bounding rects are viewport-space regardless of the tree
  the element lives in (better than today's parent-relative math inside shadow roots).

### Geometry tracker (the substance)

A single `GeometryTracker` service replaces every per-overlay observer:

- `track(element, onRect)` / `untrack(element)`. One shared ResizeObserver; one set of
  document-level listeners: `scroll` (capture phase, passive — catches nested scrollers), `resize`,
  `fullscreenchange`; one IntersectionObserver to gate work to on-screen elements.
- **Dirty-flag + rAF loop:** listeners only mark dirty; a single rAF callback reads
  `getBoundingClientRect()` for dirty (or all visible tracked) elements, compares to the last rect,
  and invokes `onRect` only on change. All reads happen together in one frame (no layout thrashing);
  no work at all when nothing is dirty.
- **Transforms/animations:** scroll + ResizeObserver miss pure-transform movement (carousels). While
  an element is on screen, poll its rect every rAF tick — a `getBoundingClientRect()` per visible
  tracked element per frame is what devtools does and is cheap (~µs each; typical page has a handful
  of _masked_ elements on screen). Off-screen elements (IntersectionObserver says so) are not
  polled. These rects feed size redraws, clip insets, caption discovery, and slot z-indexes; slot
  position comes from anchor positioning.
- **Detach detection:** on each sync tick, `element.isConnected === false` → auto-untrack + notify
  owner. Replaces N body-wide MutationObservers with zero.
- **Hidden elements:** rect with zero width/height (or `display:none`) → hide the overlay canvas,
  keep tracking.
- **Ancestor clipping:** an image scrolled half-out of an `overflow: hidden`/`auto` container must
  not paint outside it. Walk ancestors once per (re)track, cache the list of clipping ancestors
  (computed style `overflow` ≠ visible), and per sync tick intersect their rects with the element
  rect; apply as `clip-path: inset(…)` on the overlay canvas. Recompute the cached list when the
  rect changes shape unexpectedly or on `untrack/track`.

### Renderers become pure

`imageMaskOverlay` / `gifMaskPlayer` / `videoMaskOverlay` keep their public APIs
(`createMaskOverlay`, `clearMaskOverlay`, `hasMaskOverlay`, …) and all mask math
(`computeRenderedContentRect`, `maskGridSrcRect`, RLE decode, pixelation compositing — unchanged).
What they lose: parent mutation, rect math against parents, their own
ResizeObserver/MutationObserver/viewport handlers. What they gain: a layer-provided canvas and an
`onRect(rect, clip)` callback that re-renders when geometry actually changed. Decoded RLE grids get
cached in overlay state (today `updateOverlayForImage` re-decodes on every resize tick).

### Fullscreen

When `document.fullscreenElement` is set, only the fullscreen element's subtree renders — a
`documentElement`-level layer disappears. Handle in the layer, once, for all overlay types:

- On `fullscreenchange`: if a fullscreen element exists and is not our host, promote the host into
  the **top layer** via the Popover API (`popover="manual"` + `showPopover()`) — later top-layer
  entries render above the fullscreen element. On exit, `hidePopover()`.
- This composes with (does not replace) the `requestFullscreen`-interception idea for video from the
  earlier fullscreen discussion; the popover path is the belt-and-suspenders default that needs no
  page-world patching.

### Per-slot stacking (dynamic z-index)

A hardcoded `z-index: 2147483647` made masks paint over site UI that legitimately sits above the
masked element — a sticky navbar the image scrolls under, dropdowns, lightbox backdrops. Instead
every slot carries its **own** z-index, one above its own element's stacking chain:

```
slotZ(el) = clamp(1 + max(0, chainMaxZ(el)), 1, 2147483647)
```

The mask host deliberately creates **no stacking context** (zero-size, position: absolute, no
z-index/opacity/transform), so its fixed slots participate in the ROOT stacking context
individually. A lightbox backdrop at `z-index: 9999` covers thumbnail masks (z ~1) by plain CSS
stacking while the lightbox image's own mask (z 10000) paints above it — no detection code, no
global caveat.

`chainMaxZ(el)` (`geometryTracker.ts`) walks the element and its **flattened-tree** ancestors
(through `assignedSlot`, across shadow roots via the host chain, `documentElement` excluded)
estimating the z-index that decides the element's paint level in the root stacking context. Why this
is safe (CSS 2.2 Appendix E): the element's root-level paint layer is set by its root-level stacking
ancestor — either that ancestor has a numeric z-index (kept by the walk, so `slotZ` exceeds it) or
it stacks at the `auto`/`0` level (beaten by `slotZ ≥ 1` regardless of DOM order). Crossing a node
that **provably** creates a stacking context (`createsStackingContext`, `geometry.ts`: transform,
filter, backdrop-filter, perspective, mix-blend-mode, isolation, opacity < 1, positioned with
numeric z-index) discards the z-indexes accumulated below it — they are trapped inside that context
and can't affect root paint order, so a carousel's `.slick-active { z-index: 999 }` inside a
transformed track doesn't pin the slot at 1000. The predicate is deliberately incomplete
(`will-change`, `contain`, plain `sticky`, future CSS): a missed trigger only **over**estimates,
lifting a mask higher than needed — never below its own element; a false positive is the dangerous
direction, hence spec-certain triggers only. The flattened-tree walk matters: a slotted image paints
inside its slot's shadow wrappers, whose z-indexes a light-tree walk would miss (the one real
fail-open configuration).

Mechanics: `chainZ` is computed synchronously at `track()`/`refresh()` (so `attach()` sets the slot
z before the first mask frame — a newly masked image in a high-z modal never paints above its mask;
slots also start at the fail-closed maximum until the first sync) and re-walked on the shared 200 ms
slow-scan cadence to catch dynamic z-index changes. The layer applies
`nextSlotZ(tracker.chainZOf(el))` (`geometry.ts`, clamped, `Infinity`-on-error → maximum,
fail-closed) per slot on attach, on refresh, and on the tick heartbeat (which runs after the sweep's
read phase, so a chainZ change lands on the slot in the same frame the masks repaint). Caveat: site
chrome at **exactly** `slotZ = chainMax + 1` ties with the slot and loses to it (last-in-DOM wins),
so the mask over-covers chrome the image itself scrolls under — inherent, since `slotZ = chainMax`
would rely on the same DOM-order tie-break against the element's own ancestor and could fail open
instead. Caveat: overlays with **no z-index at all** (`z-index: auto` backdrops) paint below any
slot (z ≥ 1, tree-last) — masks float above them; accepted residual, as real lightbox libraries
(Bootstrap 1050, PhotoSwipe ~1500, Fancybox 9999x) all use large z-indexes.

### Caption lift

Site captions over images (text bars, gradient scrims, duration badges) at the `z-index: auto` level
are covered by the mask: the slot is tree-last, so any slot z-index that beats the image also beats
every same-level caption — no slot value can sit between two same-level siblings. The fix is on the
caption's side (`layer/captionLift.ts`): the slow scan (`layer/captionScan.ts`) collects foreign
elements hit-tested ABOVE the element (so lifting preserves the site's visual order) and gives each
qualifying one an inline `z-index: slotZ + 1`, sandwiching the mask between image and caption. The
mask is never cut; image pixels under the caption stay masked. Restored on untrack/removal/dispose;
re-asserted if the site re-renders it away; follows slot z changes on the tick.

Qualification is fail-closed (any failure → caption stays covered): z-index must apply (positioned
or flex/grid item — we never add `position`), no media content in the subtree (`img/video/canvas/…`
plus svg `image`/`foreignObject` — bare icon svgs are fine — and no `url()` backgrounds), and no
provable stacking-context ancestor other than the root: a caption flattened into a nested context
(YouTube search wraps results in `ytd-search { position: relative; z-index: 0 }`) CANNOT be raised
above the mask by any z-index — its root-level layer is the context's, which the slot must already
beat. Those captions stay covered. `chainMaxZ` substitutes the pre-lift z-index for elements we
lifted, so a masked element appearing inside a lifted caption can't feed the lift value back into
its own chainZ (would spiral to the maximum). Sample points are an edge-biased 4x4 grid (8% in) so
edge-hugging caption bars are actually hit.

Interactive extension UI (the quick-toggle eye button) does **not** live in the mask host: it mounts
into a separate `<haramblock-overlay-ui>` host (open shadow root) pinned at the maximum z-index
(`!important`) — a transient user-invoked control must never be buried under site chrome. Both hosts
share self-heal and fullscreen promotion (mask host promoted first, so the button stays above masks
in the top layer).

### Accepted tradeoffs

- **Dynamic z-index latency:** a site raising an ancestor's z-index above a slot's z (with or
  without a geometry change — the chainZ re-walk is throttled either way) is picked up on the ~200
  ms slow-scan cadence; re-stacking a container across an already-masked image is exotic and
  self-heals. Reparenting a masked element (lightboxes, React portals moving live subtrees) is
  **not** subject to this latency: the DOM observer reports the re-add and the processor
  synchronously refreshes the slot's ancestor state (clip ancestors + stacking chain) and its
  z-index.
- **Caption-lift latency / viewport bound:** a detected caption is lifted within ~200 ms + one sweep
  of coming into view. Hit testing is viewport-bound, so a caption below the fold (or a masked
  element whose caption-covering sample points are off-screen) is not lifted until scrolled into
  view — it isn't visible to the user until then anyway. Fail-closed: an unlifted caption stays
  under the mask.
- **1-frame lag:** rect is read at rAF time; a transform-animated element's mask trails by ≤1 frame.
  Same or better than today (today it doesn't move at all).
- **1-frame stale clip in nested scrollers:** slot position is compositor-glued (zero lag) but
  `clip-path` insets are sweep-written, so while a clipping scroll container scrolls, the clip edge
  is one frame behind the position — a scroll-delta-wide strip at the container edge where the mask
  bleeds past it or the image peeks out, for one frame. Before anchors, position lagged the same
  frame and the two stayed consistent; the trade is the whole mask trailing vs a transient edge
  strip.
- **display:none anchors:** a display-hidden anchor is invalid, dropping its slot to the
  `anchor(..., 0px)` fallback (viewport origin) for ≤1 frame until the sweep hides it.
  `position-visibility` removes even that frame where supported — set in two passes
  (`anchors-visible`, then `anchors-valid anchors-visible`) because no engine implements
  `anchors-valid` yet and one unknown keyword invalidates the whole declaration.
- **Print:** fixed-position overlay may not paint on the right page in print; ignore.

## 3. Implementation map

New modules (all under `entrypoints/content/presentation/layer/`):

- `overlayLayer.ts` — custom-element hosts (mask host light-DOM, UI host with open shadow root),
  anchor-name management, slot create/destroy, fullscreen/popover handling, `dispose()`. Singleton
  per document.
- `geometryTracker.ts` — pure-ish tracker described above; exports `track(el, cb)`, `untrack(el)`,
  `dispose()`. Rect/clip math split into pure helpers (`rectsEqual`, `intersectClip`) for unit
  testing.

Changed:

- `imageMaskOverlay.ts`, `gifMaskPlayer.ts`, `videoMaskOverlay.ts` — mount into the layer; drop
  parent mutation + per-overlay observers; `IMediaOverlayState` sheds
  `resizeObserver`/`cleanupObserver`/`viewportHandler`, gains `untrack` handle + cached decoded
  masks.
- `quickToggle.ts` — stage 3: move the eye button into the layer (needs `pointer-events: auto` on
  just that element inside the pointer-transparent layer).
- `utils/types/presentation.ts` — state type changes.
- Docs: `MEDIA_PROCESSING.md` overlay sections; `CONTEXT.md` vocabulary (Overlay Layer, Geometry
  Tracker); ADR for "overlays live outside site DOM".

Unchanged on purpose: all inference plumbing, `ImageProcessor` state model, mask math in
`imageLayout.ts`, and blur-class initial styling. The initial blur deliberately does **not** move
into the layer: (a) it must be atomic with the element's own paint — a synchronous `classList.add`
before first render leaves no unfiltered frame, whereas a layer canvas can only cover the element
after layout + the tracker's next rAF tick; (b) it covers _every_ pending candidate (hundreds on a
grid page) while mask overlays cover only confirmed-unsafe elements, so tracking pending elements
would multiply the rAF budget to reproduce what a filter gets for free; (c) its only real weakness
(frameworks stripping the class) is fixed by inline `style.filter` + `!important` (as
`applyBlacklistStyling` already does) and the periodic rescan, not by geometry tracking. Rule of
thumb: what needs _placement_ goes in the layer; what can be a property of the element stays on the
element.

## 4. Staging

**Stage 0 — layer + tracker infra**

- `overlayLayer.ts` + `geometryTracker.ts` with unit tests for the pure helpers; no consumers yet.
- Acceptance: tests green; layer can track a fixture element through scroll/resize/detach in a
  jsdom-approximated unit + a minimal e2e smoke.

**Stage 1 — migrate `imageMaskOverlay` (the template migration)**

- Port static-image masks to the layer; delete its observers and parent mutation; cache decoded RLE.
- Acceptance: existing image e2e scenarios pass; new e2e: mask stays aligned after (a) scrolling a
  nested `overflow:auto` container, (b) a React-style re-render that replaces the image's siblings,
  (c) a CSS-transform carousel step. Mask clipped correctly inside a scroller.

**Stage 2 — migrate `gifMaskPlayer` + `videoMaskOverlay`; fullscreen popover**

- Same mechanical migration; add `fullscreenchange` → popover promotion in the layer.
- Acceptance: GIF/video e2e scenarios pass; fullscreen on a masked video keeps the mask visible
  (manual check + e2e where the harness allows fullscreen).

**Stage 3 — quickToggle into the layer; delete dead code**

- Eye button rendered by the layer with per-element hit target; remove the old body-appended button
  and the last `data-mask-overlay` legacy-cleanup querying.

Each stage: `pnpm compile`, scoped lint, `pnpm test:unit run --exclude '**/.claude/**'`, commit (no
Claude trailer), push.

## 5. Test plan

Unit (new):

- `geometryTracker`: rect-change detection (moved / resized / unchanged → callback count), detach →
  untrack, hidden → zero-rect signal, clip intersection math (nested scrollers, partial and full
  clip-out).
- `overlayLayer`: canvas lifecycle (create/destroy idempotence), popover promotion state machine
  (enter/exit fullscreen, fullscreen element is our own host).
- Renderers: existing mask-math tests unchanged; add "re-render only on rect change" behavior.

e2e additions (`tests/e2e/features/`): the three alignment scenarios from Stage 1 acceptance;
"masked image inside modal-overlapping UI still masked"; regression run of all existing image / GIF
/ video scenarios.

## 6. Risks / open questions

- **Per-frame rect polling budget.** If a page has hundreds of masked elements visible at once, the
  rAF sweep needs a cap (poll the K most recently moved, others every Nth frame). Measure first;
  only build if real.
- **Sites at `z-index` war with 2147483647 elements** (some consent banners): only relevant when a
  tracked element's chain actually reaches the maximum (slotZ clamps to it); ours is last-in-DOM at
  equal z-index, which wins; verify.
- **Popover availability** (Chrome ≥114 / Firefox ≥125): below that, fullscreen fallback is
  "reparent host into `document.fullscreenElement`" — keep as a code path or accept unmasked-in-
  fullscreen for old browsers? Decide in Stage 2.
- **DVR alignment**: `videoDvrPlayer` (VIDEO_PLAN.md §4) should take a layer canvas from day one. If
  DVR Stage 1 lands first, migrate it in this plan's Stage 2.
- **Per-site fix hooks**: the layer is where per-site overlay knobs (e.g. overlay strategy override)
  would attach later; keep `overlayLayer` options object extensible but don't build the registry
  here.
