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

## Removal

```sh
claude mcp remove playwright -s local
```
