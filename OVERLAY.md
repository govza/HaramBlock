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
<haramblock-overlay-layer>          ← custom element, appended to document.documentElement
  #shadow-root (open)               ← isolates our styles from site CSS; open for e2e/devtools
    <style> … </style>
    <div class="layer">             ← position: fixed; inset: 0; pointer-events: none;
                                      z-index: dynamic (see "Host stacking")
      <canvas data-overlay …>       ← one per tracked media element
      <canvas data-overlay …>
    </div>
```

Key properties:

- **Viewport coordinates only.** `position: fixed` means an overlay's placement is exactly the
  element's `getBoundingClientRect()` — no parent rect math, no `parent.style.position` mutation.
  Placement via `transform: translate(x, y)` + width/height (transform avoids layout on move).
- **Immune to site frameworks.** Nothing is injected next to the media element; React can re-render
  whatever it wants. Shadow root (closed) keeps site CSS resets and `querySelectorAll` sweeps out.
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
  polled.
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

### Host stacking (dynamic z-index)

A hardcoded `z-index: 2147483647` made masks paint over site UI that legitimately sits above the
masked element — a sticky navbar the image scrolls under, dropdowns, toasts. Instead the host's
z-index is dynamic:

```
hostZ = clamp(1 + max(0, max over tracked elements of chainMaxZ(el)), 1, 2147483647)
```

`chainMaxZ(el)` (`geometryTracker.ts`) walks the element and its **flattened-tree** ancestors
(through `assignedSlot`, across shadow roots via the host chain, `documentElement` excluded)
estimating the z-index that decides the element's paint level in the root stacking context. Why this
is safe (CSS 2.2 Appendix E): the element's root-level paint layer is set by its root-level stacking
ancestor — either that ancestor has a numeric z-index (kept by the walk, so `hostZ` exceeds it) or
it stacks at the `auto`/`0` level (beaten by `hostZ ≥ 1` regardless of DOM order). Crossing a node
that **provably** creates a stacking context (`createsStackingContext`, `geometry.ts`: transform,
filter, backdrop-filter, perspective, mix-blend-mode, isolation, opacity < 1, positioned with
numeric z-index) discards the z-indexes accumulated below it — they are trapped inside that context
and can't affect root paint order, so a carousel's `.slick-active { z-index: 999 }` inside a
transformed track no longer pins the host at 1000 page-wide. The predicate is deliberately
incomplete (`will-change`, `contain`, plain `sticky`, future CSS): a missed trigger only
**over**estimates, lifting masks higher than needed — never below their own element; a false
positive is the dangerous direction, hence spec-certain triggers only. The flattened-tree walk
matters: a slotted image paints inside its slot's shadow wrappers, whose z-indexes a light-tree walk
would miss (the one real fail-open configuration).

Meanwhile a navbar with `z-index: 100 > hostZ` paints over masks exactly as it paints over the
images beneath it — no per-overlay z-index guessing, no site-CSS mutation.

Mechanics: `chainZ` is computed synchronously at `track()`/`refresh()` (so `attach()` raises the
host before the first mask frame — a newly masked image in a high-z modal never paints above its
mask; a DOM-observer re-add of a masked element triggers the same synchronous `refresh()`) and
re-walked on the shared 200 ms slow-scan cadence to catch dynamic z-index changes. The layer applies
`nextHostZ(tracker.maxChainZ())` (`geometry.ts`, clamped, `Infinity`-on-error → maximum, i.e.
fail-closed) on attach, on refresh, and on the tick heartbeat (which runs after the sweep's read
phase, so a chainZ change lands on the host in the same frame the masks repaint); lowering after
detach lags a tick, which is safe. Caveat: hostZ is global to the layer — one tracked element inside
a `z-index: 9999` modal lifts all masks to 10000 until it's untracked, degrading the navbar fix back
to the old over-cover behavior (occlusion still handles full coverage). Caveat: site chrome at
**exactly** `hostZ = chainMax + 1` ties with the host and loses to it (last-in-DOM wins), so the
mask over-covers chrome the image itself scrolls under — inherent to any single global hostZ, since
`hostZ = chainMax` would rely on the same DOM-order tie-break against the element's own ancestor and
could fail open instead.

### Caption lift

Site captions over images (text bars, gradient scrims, duration badges) at the `z-index: auto` level
are covered by the mask: the host is tree-last, so any host z-index that beats the image also beats
every same-level caption — no host value can sit between two same-level siblings. The fix is on the
caption's side (`layer/captionLift.ts`): the occlusion slow scan collects foreign elements
hit-tested ABOVE the element (so lifting preserves the site's visual order) and gives each
qualifying one an inline `z-index: hostZ + 1`, sandwiching the mask between image and caption. The
mask is never cut; image pixels under the caption stay masked. Restored on untrack/removal/dispose;
re-asserted if the site re-renders it away; follows hostZ changes on the tick.

Qualification is fail-closed (any failure → caption stays covered): z-index must apply (positioned
or flex/grid item — we never add `position`), no media content in the subtree (`img/video/canvas/…`
plus svg `image`/`foreignObject` — bare icon svgs are fine — and no `url()` backgrounds), and no
provable stacking-context ancestor other than the root: a caption flattened into a nested context
(YouTube search wraps results in `ytd-search { position: relative; z-index: 0 }`) CANNOT be raised
above the mask by any z-index — its root-level layer is the context's, which the host must already
beat. Those captions stay covered. `chainMaxZ` substitutes the pre-lift z-index for elements we
lifted, so a masked element appearing inside a lifted caption can't feed the lift value back into
hostZ (would spiral to the maximum). Sample points are an edge-biased 4x4 grid (8% in) so
edge-hugging caption bars are actually hit.

Interactive extension UI (the quick-toggle eye button) does **not** live in the mask host: it serves
registered-but-untracked elements too (safe images, images toggled to visible), whose chains never
raise hostZ, and a child can't escape its host's stacking context. It mounts into a separate
`<haramblock-overlay-ui>` host pinned at the maximum z-index (`!important`) — a transient
user-invoked control must never be buried under site chrome. Both hosts share self-heal and
fullscreen promotion (mask host promoted first, so the button stays above masks in the top layer).

### Occlusion (was: the over-cover tradeoff)

Even with the dynamic host z-index, chainMaxZ can overestimate (z-indexes that don't apply, or
nested contexts the boundary predicate can't prove), so masks can still float above site UI meant to
cover the element — found in practice: open a lightbox and the thumbnail masks float above its
backdrop. Handled by **occlusion detection** (`layer/occlusion.ts`): on the shared 200 ms slow-scan
cadence per visible tracked element, hit-test an edge-biased 4x4 grid (16 points) spread over its
visible (clip-reduced) rect via `document.elementFromPoint` — the same pass that collects
caption-lift candidates. The slot is hidden only when **every** in-viewport point is covered by
_opaque_ foreign content — the hit (or a non-shared ancestor, covering transparent centering
containers inside modals) paints real pixels: media tag, `background-image`, `backdrop-filter`, or
background-color alpha ≥ `OCCLUDER_MIN_ALPHA` (0.45, catching the ubiquitous `rgba(0,0,0,.5)`
backdrops).

Everything fails toward "mask stays visible": transparent overlays (stretched-link cards),
unparseable colors, points hitting the element/its ancestors/descendants, our own layer host, and
elements with `pointer-events: none` (un-hit-testable → never reported occluded). Partial coverage
keeps the mask — only full coverage hides it (sticky headers are handled by host stacking above, not
by occlusion).

### Accepted tradeoffs

- **Occlusion latency:** a lightbox's backdrop hides underlying masks up to ~200 ms + one sweep
  after it opens (hit testing is throttled). The transition is user-visible anyway.
- **Dynamic z-index latency:** a site raising an ancestor's z-index above hostZ (with or without a
  geometry change — the chainZ re-walk is throttled either way) is picked up on the same ~200 ms
  cadence; re-stacking a container across an already-masked image is exotic and self-heals.
  Reparenting a masked element (lightboxes, React portals moving live subtrees) is **not** subject
  to this latency: the DOM observer reports the re-add and the processor synchronously refreshes the
  slot's ancestor state (clip ancestors + stacking chain) and the host z-index.
- **Caption-lift latency / viewport bound:** a detected caption is lifted within ~200 ms + one sweep
  of coming into view. Hit testing is viewport-bound, so a caption below the fold (or a masked
  element whose caption-covering sample points are off-screen) is not lifted until scrolled into
  view — it isn't visible to the user until then anyway. Fail-closed: an unlifted caption stays
  under the mask.
- **Semi-dim backdrops below 0.45 alpha** keep masks visible on purpose — the content shows through,
  so hiding the mask would reveal it.
- **1-frame lag:** rect is read at rAF time; a transform-animated element's mask trails by ≤1 frame.
  Same or better than today (today it doesn't move at all).
- **Print:** fixed-position overlay may not paint on the right page in print; ignore.

## 3. Implementation map

New modules (all under `entrypoints/content/presentation/layer/`):

- `overlayLayer.ts` — custom-element host, open shadow root, style sheet, canvas create/destroy,
  fullscreen/popover handling, `dispose()`. Singleton per document.
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
  tracked element's chain actually reaches the maximum (hostZ clamps to it); ours is last-in-DOM at
  equal z-index, which wins; verify.
- **Popover availability** (Chrome ≥114 / Firefox ≥125): below that, fullscreen fallback is
  "reparent host into `document.fullscreenElement`" — keep as a code path or accept unmasked-in-
  fullscreen for old browsers? Decide in Stage 2.
- **DVR alignment**: `videoDvrPlayer` (VIDEO_PLAN.md §4) should take a layer canvas from day one. If
  DVR Stage 1 lands first, migrate it in this plan's Stage 2.
- **Per-site fix hooks**: the layer is where per-site overlay knobs (e.g. overlay strategy override)
  would attach later; keep `overlayLayer` options object extensible but don't build the registry
  here.
