# Logging Handoff — findings from the Reddit masking debug session (2026-07-06)

Context written by another session (branch `fix/img-decode-fail-open`, PR #73) after debugging
three Reddit masking failures end-to-end through the Playwright MCP. Every gap below cost real
wall-clock time during that hunt; each comes with the concrete solution the debugging session
wished it had. Companion doc: the new "Debugging Techniques" section in `docs/PLAYWRIGHT.md`
(on PR #73's branch), which covers the MCP-side reading tricks.

## The bugs we chased (why logging mattered)

1. **decode() fail-open** (`ImageProcessor.queueInference`): Firefox rejects `img.decode()` for
   lazy images; the error path removed the blur and revealed images. The wide-event log said only
   `error ... (content-only)` — no reason, no stage, so the cause had to be reverse-engineered from
   code.
2. **Overlay layer hidden by Reddit's `:not(:defined)` FOUC guard** (`overlayLayer.ts`): inference
   succeeded, slots positioned correctly, `styleMs` logged — yet nothing was visible. Nothing in
   any log distinguishes "mask drawn" from "mask drawn but the layer host computes
   `visibility: hidden`".
3. **srcset density-corrected naturalWidth** (`imageMaskOverlay.ts` + `prediction.ts`): masks
   painted only over the top-left of gallery images. The render path has **zero logging**, and the
   stored predictions looked internally consistent, so this took temporary `console.log`
   instrumentation + IndexedDB spelunking to pin.

## Problems → solutions to implement on this branch

### 1. `skipped`/`error` events carry no reason

`completeContentTiming(src, { status: 'error', error })` accepts an Error, but the console summary
line (`backgroundRpc.storeContentEvent`) prints only `status hostname +Nms (content-only)`. During
bug #1 we stared at 30 identical `error +10ms` lines with `queueMs/fetchMs/decodeMs: undefined` and
no clue that `img.decode()` was the thrower.

- Add a `reason` (short machine string: `below-min-size`, `svg`, `decode-rejected`, `load-error`,
  `send-failed`, …) to the wide event, set at every `completeContentTiming` call site.
- Include `reason` and `error?.message` in the one-line console summary, not just the object.

### 2. Console objects are unreadable through the Playwright MCP

The MCP console capture flattens any logged object to the literal string `Object`. The existing
`console.log(prefix, summary, event)` pattern loses the entire payload when read by an LLM through
`browser_console_messages` / the `.playwright-mcp/console-*.log` files.

- Emit **one single-line JSON string** per event when console logging is enabled (e.g.
  `console.log('[hb] ' + JSON.stringify(event))`), or add a `jsonConsole` toggle to log settings.
  Keep the pretty object log for humans if desired, but the JSON line is what automation can read.
- This applies to every debug log added on this branch: always `JSON.stringify`, always one line.

### 3. Background (service worker) logs are invisible to the MCP

`browser_console_messages` only sees the **page** console. Anything logged only in the MV3 service
worker (model load, queue decisions, cache hits on the background side) can't be read at all
through the MCP. During the session we could only see wide events because the merged log happens
content-side.

- Ensure every diagnostic that matters is either logged content-side or **persisted** (wide-event
  store) and readable from an extension page.
- Add a dev-only dump hook reachable via `browser_evaluate` on `chrome-extension://<id>/popup.html`,
  e.g. `globalThis.__hbDumpEvents(n)` returning the last n wide events as JSON. (The IndexedDB
  `ImageDatabase`/`predictions` store was queryable this way and it was the single most useful
  ground-truth source of the whole session.)

### 4. No visibility into where a verdict came from

The user's Firefox log showed `cached` events, but content-side there is no way to tell whether a
mask came from fresh inference, the IndexedDB cache (`seedCache` on init), or the in-memory
`ImageProcessor.cache`. Bug #3 was initially misdiagnosed as a stale-cache problem partly because
of this.

- Add `source: 'inference' | 'db-cache' | 'memory-cache'` to the completion/styled event.

### 5. The presentation/render path logs nothing

`imageMaskOverlay.render()` → `renderUnifiedCanvasMask()` computes: contentRect (object-fit math),
mask grid src rect, canvas sizes, pixelation block size. None of it is logged. Bug #3 required
patching a temporary log in, rebuilding, and re-navigating (twice — first attempt logged objects,
see problem 2).

- Add a `logger.withTag('maskOverlay').debug` one-line JSON snapshot per render: element src tail,
  `prediction.width/height`, `maskTransform`, `naturalWidth/Height`, `currentSrc === prediction.src`,
  `lastSize`, `contentRect`, grid dims, `objectFit`. Off by default, on via log settings.
- **Throttle it**: carousel scale animations trigger a redraw every ~15ms per element (size changes
  each frame), so an unthrottled per-render log floods instantly. Dedupe per element until inputs
  change, or rate-limit.

### 6. Cheap invariant warnings would have caught two bugs instantly

- **Dims mismatch**: in `resolveBitmap` (background), warn when `task.originalWidth` differs from
  the decoded `bitmap.width` by more than ~2%. This is exactly the srcset density-corrected
  `naturalWidth` signature (944px bitmap reported as 1199) — bug #3 would have been one log line.
  (PR #73 now trusts bitmap dims, but the warning still documents element/resource skew.)
- **Prediction self-consistency**: warn if `maskTransform.scaleX * mask.width` deviates from
  `prediction.width` (and same for Y). We bulk-audited this by hand via IndexedDB; it should be a
  built-in check at cache-write time.
- **Layer visibility**: after attaching the overlay host, assert
  `getComputedStyle(host).visibility === 'visible'` (and `display !== 'none'`) and warn otherwise —
  that's bug #2 reduced to a log line. A periodic re-check (the tracker tick already exists) would
  catch late-loading site CSS.

### 7. Stage markers are mostly `undefined` on failure paths

Failed/skipped events showed `queueMs/fetchMs/decodeMs/sendMs/waitMs: undefined`, so you can't tell
how far an image got (never sent? sent but no reply? reply but style failed?). `markSent`/
`markReceived` exist but only feed the happy path.

- Populate whichever stage timestamps exist at completion time regardless of status, or add an
  explicit `stage: 'queued' | 'sent' | 'received' | 'styled'` field to every terminal event.

## Verification notes for this branch

- Read logs through the MCP the way an LLM will: `browser_console_messages` or grep
  `.playwright-mcp/console-*.log` — if a payload shows as `Object`, it failed the readability bar.
- `pnpm test:unit` currently globs into this worktree from the main checkout and reports 12
  phantom suite failures there (`.claude/worktrees/**` needs excluding in vitest config — nice
  small win for this branch).
