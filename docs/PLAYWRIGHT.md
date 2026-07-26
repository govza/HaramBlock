# Playwright MCP with the Built Extension (Alternative Setup)

Alternative setup for driving a real Chromium — with the HaramBlock extension pre-installed — from
Claude Code via the [Playwright MCP server](https://github.com/microsoft/playwright-mcp). The
primary browser-debugging setup is the chrome-devtools MCP attached to the WXT dev browser; start
there, and with either setup use [BROWSER_DEBUGGING.md](BROWSER_DEBUGGING.md) for the debugging
techniques themselves (health probes, IndexedDB inspection, instrumentation, screenshots). This
document covers only what is Playwright-MCP-specific: the config file, the static-build workflow,
and the persistent profile.

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
- Profile state (per-site settings, cached verdicts in IndexedDB) persists in
  `.claude/pw-mcp-profile` across launches. Delete that directory for a clean slate. The unpacked
  extension id is profile-specific — `ls .claude/pw-mcp-profile/Default/IndexedDB/` shows it as
  `chrome-extension_<ID>_0.indexeddb.leveldb`.
- If a navigation fails with "Browser is already in use for … pw-mcp-profile", a previous Chromium
  is still holding the profile (e.g. after an MCP reconnect): `pkill -f pw-mcp-profile`, then
  navigate again.
- Console output is saved to `.playwright-mcp/console-*.log`; grep it rather than re-fetching
  messages through the tool. Screenshots land in the working directory (or `.playwright-mcp/`).

## Removal

```sh
claude mcp remove playwright -s local
```
