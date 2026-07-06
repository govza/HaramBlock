# Playwright MCP with the Built Extension

Setup for driving a real Chromium — with the HaramBlock extension pre-installed — from Claude Code
via the [Playwright MCP server](https://github.com/microsoft/playwright-mcp). Useful for
interactively debugging the extension (navigate pages, inspect masking, read console output,
screenshot the popup) without writing a wdio test.

## How It Works

`@playwright/mcp` has no CLI flag for loading extensions (its `--extension` flag means "attach to an
already-running browser" — not what we want). Instead, extension loading goes through a config file
passed via `--config`: the `browser.launchOptions.args` are forwarded to `launchPersistentContext`,
and Chromium's `--load-extension` does the rest.

Requirements baked into the config:

- **Headed** (`headless: false`) — MV3 extensions need a headed persistent context.
- **Persistent profile** (`userDataDir`) — extensions don't load into ephemeral contexts.
- **Absolute paths** — the config is machine-specific, so it lives under the gitignored `.claude/`
  and is not committed.

## Setup (once per machine)

1. Build the extension:

   ```sh
   pnpm build
   ```

2. Create `.claude/playwright-mcp.config.json` (replace `<repo>` with the absolute repo path):

   ```json
   {
     "browser": {
       "browserName": "chromium",
       "isolated": false,
       "userDataDir": "<repo>/.claude/pw-mcp-profile",
       "launchOptions": {
         "headless": false,
         "args": [
           "--disable-extensions-except=<repo>/.output/chrome-mv3",
           "--load-extension=<repo>/.output/chrome-mv3"
         ]
       }
     }
   }
   ```

3. Register the MCP server (local scope — private to you, this project):

   ```sh
   claude mcp add playwright --scope local -- \
     npx -y @playwright/mcp@latest --config <repo>/.claude/playwright-mcp.config.json
   ```

4. Restart the Claude Code session — MCP tools are loaded at startup, so a server added mid-session
   isn't callable until the next one. Verify with `/mcp` or:

   ```sh
   claude mcp get playwright
   ```

## Usage Notes

- The first `browser_navigate` launches Chromium with the extension already installed.
- The MCP loads the **static build output** — after changing extension source, run `pnpm build`
  again, then `browser_close`; the next navigation relaunches with the fresh build.
- The MV3 background service worker registers at `chrome-extension://<id>/background.js`. To reach
  extension pages (e.g. the popup), navigate to `chrome-extension://<id>/popup.html`.
- Profile state (per-site settings, cached verdicts in IndexedDB) persists in
  `.claude/pw-mcp-profile` across launches. Delete that directory for a clean slate.
- If a navigation fails with "Browser is already in use for … pw-mcp-profile", a previous Chromium
  is still holding the profile (e.g. after an MCP reconnect): `pkill -f pw-mcp-profile`, then
  navigate again.

## Debugging Techniques

Patterns that have proven useful when hunting extension bugs through the MCP:

### Inspect the overlay layer and masked elements

The overlay layer's shadow root is **open**, so `browser_evaluate` can walk it directly from the
page:

```js
const layer = document.querySelector('haramblock-overlay-layer');
const slots = layer.shadowRoot.querySelectorAll('[data-overlay-slot]');
// per-slot: getComputedStyle(slot).transform / width / display, slot.querySelector('canvas')
```

Cross-reference with site images via the processed-status attributes
(`img[data-haramblock-processed-unsafe]` etc.), `img.currentSrc`, `naturalWidth/naturalHeight`, and
`getBoundingClientRect()`. Site shadow DOM (e.g. Reddit's `gallery-carousel`) is usually open too —
reach buttons with `el.shadowRoot.querySelector(...)` and `.click()` them from `browser_evaluate`.

### Query the extension's IndexedDB (cached predictions)

Find the extension ID (unpacked IDs are profile-specific), then evaluate against any extension page
— extension pages share the service worker's origin and see the same IndexedDB:

```sh
ls .claude/pw-mcp-profile/Default/IndexedDB/   # chrome-extension_<ID>_0.indexeddb.leveldb
```

Then `browser_navigate` to `chrome-extension://<ID>/popup.html` and `browser_evaluate` a plain
`indexedDB.open('ImageDatabase')` → `getAll()` on the `predictions` store. This exposes each
prediction's `width/height`, `maskTransform`, and RLE masks — invariants like
`maskTransform.scaleX × mask.width ≈ width` can be audited in bulk, and the RLE can be decoded
in-page to measure the mask's extent inside its grid.

### Temporary instrumentation beats deduction

When DOM-level probing isn't enough, add a temporary `console.log` in the suspect code path, then
`pnpm build` → `browser_close` → re-navigate. Two capture gotchas:

- The MCP console log **flattens nested objects** to `Object` — log `JSON.stringify(payload)`
  instead of the object itself.
- Console output is saved to `.playwright-mcp/console-*.log`; grep it rather than re-fetching
  messages through the tool.

Remove the instrumentation before committing.

### Canvas pixel readback is CORS-limited

Mask overlay canvases draw cross-origin images, so they are **tainted** — `getImageData` from
`browser_evaluate` throws. Intermediate canvases that only receive `fillRect`/mask grids stay
untainted; if pixel-level ground truth is needed, instrument the extension code to measure there
(e.g. alpha-extent scans) and log the result.

### Screenshots

`browser_take_screenshot` with `type: "png"` can hit its 5s timeout on animation-heavy pages;
`type: "jpeg"` is faster. Screenshots land in the working directory (or `.playwright-mcp/`) — Read
the file to actually look at it, and delete throwaways afterwards.

## Removal

```sh
claude mcp remove playwright -s local
```
