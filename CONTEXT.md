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

**Safe / Unsafe image**: An image without / with predictions. Unsafe images are masked when Forced
Visibility is `'auto'`. _Avoid_: clean image, flagged image
