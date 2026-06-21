// Matches GIF source URLs by extension (query/hash tolerated).
// NOTE: detection is extension-only; CDN-hosted GIFs with extensionless URLs are
// not recognized (the dataset.contentType hint is not currently populated).
export const GIF_URL_PATTERN = /\.gif(?:[?#]|$)/i;

// Animated GIF inference sampling. Every frame is decoded for playback, but inference
// runs only on an evenly-spread subset whose size scales with the frame count and is
// bounded so long GIFs don't flood the inference queue.
export const GIF_MIN_INFERENCE_FRAMES = 6;
export const GIF_MAX_INFERENCE_FRAMES = 24;

// Mask-persistence floor (frames). Raised to the sampling stride at runtime so a
// detection on a sampled frame still masks the un-inspected frames around it.
export const GIF_MIN_MASK_INERTIA = 4;

// Hard ceiling on decoded frames to bound memory/CPU on pathological GIFs.
export const MAX_GIF_DECODE_FRAMES = 300;
