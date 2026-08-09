# Browser Debugging Playbook

The single entry point for debugging the extension in a real browser: launch, probe, iterate, clean
up. The primary setup is the **chrome-devtools MCP attached to the WXT dev browser** (`pnpm dev` +
remote debugging port 9222) — server configuration lives in [AI_DEVELOPMENT.md](AI_DEVELOPMENT.md).
The alternative setup is the **Playwright MCP with a static build** — see
[PLAYWRIGHT.md](PLAYWRIGHT.md). The techniques in this playbook apply to either; tool names below
are the chrome-devtools ones.

## The Debug Loop

1. **Free port 3000 first.** `pnpm dev` fails fast when the port is taken
   (`scripts/assert-dev-port-free.mjs`). The usual holder is a zombie node child — on Windows,
   killing a terminal (or stopping a background task) orphans the child that owns the port. Kill the
   port-3000 listener explicitly; never let WXT drift to another port (see
   [AI_DEVELOPMENT.md](AI_DEVELOPMENT.md) "Dev-Mode Gotchas").
2. **Start the dev server in the background with stdin held open** — WXT exits immediately on stdin
   EOF. Via the Bash tool: `tail -f /dev/null | pnpm dev` as a background task. (A PowerShell
   `Start-Sleep | pnpm dev` pipeline stalls pnpm entirely — don't.)
3. **Wait for debug port 9222** to accept connections before attaching the MCP. The dev browser is
   launched with `--remote-debugging-port=9222` (gitignored `web-ext.config.ts`).
4. **Expect MCP reconnects.** If the MCP was already attached when the browser relaunched, it
   reconnects and reports **fresh page ids** — re-list pages instead of reusing ids from before the
   reconnect. (A first attach after the browser is up connects directly, no reconnect.)
5. **Iterate.** The WXT file watcher does not reliably rebuild content scripts on this machine —
   restart the dev server to pick up content-script edits (~1.4 s build). The background is served
   live from the dev server, but the service worker may still run a stale cached build — see
   "Extension Pages and Force-Reload" below for the recovery.
6. **Clean up.** Stop the background dev-server task, then kill the port-3000 listener explicitly
   (step 1 explains why stopping the task alone is not enough): find the PID with
   `netstat -ano | grep :3000`, kill it with `taskkill /PID <pid> /F` (Windows) or `kill <pid>`
   (POSIX), and confirm the port is free.

## Extension Pages and Force-Reload

- `new_page` cannot open `chrome-extension://` URLs, but `navigate_page` on an existing tab can —
  e.g. to reach `chrome-extension://<id>/popup.html`.
- `chrome://extensions` opens fine. From a tab on that page, force-reload the extension via
  `evaluate_script`:

  ```js
  chrome.developerPrivate.reload('<extension-id>');
  ```

  This is the recovery move for the stale-service-worker build skew documented in
  [AI_DEVELOPMENT.md](AI_DEVELOPMENT.md) (tell-tale console error:
  `Frame prediction arrived without timestampSec`).

## What Each World Can See

- `evaluate_script` runs in the page's **main world**: it cannot reach content-script
  (isolated-world) module state and cannot intercept the content script's console.
- Content-script logs **do** appear in `list_console_messages`.
- The **service-worker console is unreachable** from the MCP entirely. To see background-side
  values, smuggle debug fields into objects that flow back to the content script and log them there.

## DOM Health Probes by Marker Attribute

The extension marks everything it touches, so page-side `evaluate_script` can audit its state:

| Marker                                            | Where       | Meaning                                                                       |
| ------------------------------------------------- | ----------- | ----------------------------------------------------------------------------- |
| `data-haramblock-instance`                        | `<html>`    | Instance sentinel nonce; a changed value means a successor instance took over |
| `data-haramblock-processed-safe/-unsafe/-skipped` | media       | Verdict landed for the element                                                |
| `data-haramblock-video-discovered`                | video/host  | Video adopted by a session                                                    |
| `[data-mask-overlay="unified-mask-overlay"]`      | overlay div | Image mask overlay                                                            |
| `[data-video-mask-overlay]`                       | overlay div | Video mask overlay                                                            |
| `[data-gif-mask-player]`                          | overlay div | Animated-GIF mask player                                                      |
| `[data-video-dvr-player]`                         | overlay div | DVR presenter overlay                                                         |

**The DVR tell:** a `[data-video-dvr-player]` overlay present with an **empty** base-canvas
`style.filter` is the happy path (verdicts are matching frames). A **persistent blur filter** on the
base canvas means the presenter is fail-closed — verdicts are not reaching or not matching the
frames. The DVR overlay persists across pause, clean streaks, and `ended` (continuous DVR) — it is
replaced by a `[data-video-mask-overlay]` only when the video leaves the viewport; that suspension
handover is normal, not a failure.

## Test Pages

The haramblock.com gallery serves deterministic fixtures:

- **Images:** `https://haramblock.com/gallery/basic?mode=nsf-female&count=25&size=medium` — `mode`
  is `sf-neutral` (safe) or `nsf-female` (unsafe), `count` 1–100, `size` one of
  `icon | small | medium | large | largex2 | original`, plus `overlay` and `naturalized` booleans
  (see `tests/e2e/constants/index.ts` for the canonical builder).
- **Video:** `https://haramblock.com/gallery/video?mode=sf-neutral&count=1`

Autoplay is often blocked in the debug profile — start playback from `evaluate_script` with the
muted-`play()` trick:

```js
const video = document.querySelector('video');
video.muted = true;
video.play();
```

## Inspection Techniques

### Inspect mask overlays and masked elements

Mask overlays are plain divs injected into the site DOM next to the media element, so a script
evaluated in the page can query them directly:

```js
const overlays = document.querySelectorAll('[data-mask-overlay="unified-mask-overlay"]');
// also: [data-video-mask-overlay], [data-gif-mask-player]
// per-overlay: getComputedStyle(overlay).top / width / display, overlay.querySelector('canvas')
```

Cross-reference with site images via the processed-status attributes
(`img[data-haramblock-processed-unsafe]` etc.), `img.currentSrc`, `naturalWidth/naturalHeight`, and
`getBoundingClientRect()`. Site shadow DOM (e.g. Reddit's `gallery-carousel`) is usually open too —
reach buttons with `el.shadowRoot.querySelector(...)` and `.click()` them from the evaluated script.

### Query the extension's IndexedDB (cached predictions)

Extension pages share the service worker's origin and see the same IndexedDB. Navigate an existing
tab to `chrome-extension://<id>/popup.html` (find the id on `chrome://extensions` — unpacked ids are
profile-specific), then evaluate a plain `indexedDB.open('ImageDatabase')` → `getAll()` on the
`predictions` store. This exposes each prediction's `width/height`, `maskTransform`, and RLE masks —
invariants like `maskTransform.scaleX × mask.width ≈ width` can be audited in bulk, and the RLE can
be decoded in-page to measure the mask's extent inside its grid.

### Temporary instrumentation beats deduction

When DOM-level probing isn't enough, add a temporary `console.log` in the suspect code path with a
greppable tag (`[DEBUG-frame]`, `[DEBUG-verdict]`, …), rebuild/restart, and read it from the console
messages. Log `JSON.stringify(payload)` rather than the object — tool consoles flatten nested
objects to `Object`. Grep for `[DEBUG-` and remove all instrumentation before committing.

### Canvas pixel readback is CORS-limited

Mask overlay canvases draw cross-origin images, so they are **tainted** — `getImageData` from an
evaluated script throws. Intermediate canvases that only receive `fillRect`/mask grids stay
untainted; if pixel-level ground truth is needed, instrument the extension code to measure there
(e.g. alpha-extent scans) and log the result.

### Screenshots

PNG screenshots can time out on animation-heavy pages; JPEG is faster. If the tool saves the
screenshot to disk instead of returning it (the Playwright MCP does — see
[PLAYWRIGHT.md](PLAYWRIGHT.md)), read the file to actually look at it, and delete throwaways
afterwards.
