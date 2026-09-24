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

**Verdict Interpreter**: The single reader of a video's raw playback verdicts. Decides what covers
each presented frame and classifies each new sample for the session machine, so masking and status
share one confirmation rule. _Avoid_: verdict filter, smoothing

**Transient Hit**: A run of at most `maxSuppressedRun` consecutive low-confidence unsafe playback
samples with a clean edge on each side (an adjacent clean sample, or a coverage gap before the run).
Treated as clean everywhere — a model hallucination is never shown as a mask flash. _Avoid_: false
positive, blip

**Confident Hit**: An unsafe sample whose top detection probability reaches
`min(scoreThreshold × confidenceCoefficient, confidenceCap)`. One Confident Hit makes its run a real
hit, however short. _Avoid_: strong hit

**Safe / Unsafe image**: An image without / with predictions. Unsafe images are masked when Forced
Visibility is `'auto'`. _Avoid_: clean image, flagged image
