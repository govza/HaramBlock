# CSS background-image processing

Elements that display images via CSS `background-image` are not processed by the media pipeline.

## Why this is out of scope

There is no easy way to do this. The pipeline is built end-to-end around concrete media elements
(`HTMLImageElement` / `HTMLVideoElement`), and background images break every layer of it:

- **Detection**: `DomObserver` matches `img`/`video` tags and watches `src`/`srcset` attributes. A
  background URL lives in the `style` attribute or a stylesheet, so detecting it reliably requires
  computed-style checks on arbitrary elements and mutations - expensive without fragile heuristics
  (inline `url(` sniffing, size/viewport gating).
- **Masking**: the overlay path assumes `naturalWidth`/`object-fit`; background elements need
  separate content-rect math from `background-size`/`position`/`repeat`, plus a separate
  self-cleaning and initial-blur path (the startup flash guard is `img`-only).
- Multiple backgrounds / gradients mixed with `url()` add further per-layer geometry complexity.

The cost of a parallel non-`<img>` pipeline outweighs the benefit for what is mostly a
thumbnail-overlay edge case (e.g. YouTube's cued-thumbnail overlay).

## Prior requests

- #78 - "Images via CSS background-image are not processed"
