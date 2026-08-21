# HaramBlock

Browser extension that detects inappropriate content in page media with on-device AI and masks it,
with per-host and per-image user overrides.

## Language

**Quick Toggle**: The per-image eye button that lets the user override the AI decision for one image
without changing site-wide settings. _Avoid_: eye toggle, quick switch

**Forced Visibility**: The user's per-image override of the AI decision: `'auto'` (AI decides),
`'visible'` (force show), `'blocked'` (force hide). Persisted per image src. _Avoid_: toggle state,
`null` (legacy spelling of `'auto'`)

**Mask Overlay**: The absolutely-positioned canvas inserted next to an image in its parent that
pixelates the predicted regions and tracks the image's geometry. _Avoid_: mask layer, blur overlay

**Relay Fetch**: The background fetching a media URL on behalf of the content script (host
permissions exempt background fetch from CORS), so the content script can decode it origin-clean.
_Avoid_: proxy fetch, CORS bypass

**Relay Audio**: Delayed audio for an origin-tainted video: a hidden audio element playing the
video's original URL one Presentation Delay behind the live edge, while the page element is kept
silent. _Avoid_: audio proxy, blob audio

**Safe / Unsafe image**: An image without / with predictions. Unsafe images are masked when Forced
Visibility is `'auto'`. _Avoid_: clean image, flagged image

**Reconciliation Loop**: The content script's convergence loop for images: change signals mark
images dirty, and a coalesced reconcile pass re-converges each dirty image's presentation
idempotently. Distinct from the predecessor sweep (crashed-instance overlay cleanup) and the
stale-overlay sweep. _Avoid_: rescan, re-check

**Dirty image**: A tracked image with a pending change hint (load/error, mutation, Verdict arrival)
awaiting the next Reconciliation Loop. _Avoid_: invalidated image, pending image

**Safety Tick**: The periodic timer that marks every tracked image dirty, bounding how long any
missed signal can leave an image unreconciled. _Avoid_: rescan interval, polling
