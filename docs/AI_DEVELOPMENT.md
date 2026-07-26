# AI-Assisted Development Setup

This guide covers the setup of AI tools for developing and debugging the HaramBlock browser
extension.

## Chrome DevTools MCP

Enables Claude to interact with Chrome browser sessions for debugging and testing. This section
covers the one-time server setup; the debugging workflow itself (launch, probe, iterate, clean up)
is documented in [BROWSER_DEBUGGING.md](BROWSER_DEBUGGING.md).

### Prerequisites

- Chrome Canary (or Chrome 144+)
- Node.js with npx

### WXT Configuration

In `web-ext.config.ts`, configure Chrome Canary with remote debugging:

```typescript
export default defineWebExtConfig({
  binaries: {
    chrome: 'C:/Users/<USERNAME>/AppData/Local/Google/Chrome SxS/Application/chrome.exe'
  },
  chromiumProfile: resolve('.wxt/chrome-data'),
  keepProfileChanges: true,
  chromiumArgs: ['--remote-debugging-port=9222']
});
```

### Claude Code MCP Configuration

Add to `~/.claude.json` under the project:

**Windows:**

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "type": "stdio",
      "command": "cmd",
      "args": ["/c", "npx", "chrome-devtools-mcp@latest", "-u", "http://127.0.0.1:9222"]
    }
  }
}
```

**Linux/macOS:**

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "type": "stdio",
      "command": "npx",
      "args": ["chrome-devtools-mcp@latest", "-u", "http://127.0.0.1:9222"]
    }
  }
}
```

### Usage

1. Run `pnpm dev` to start Chrome with extension
2. Restart Claude Code to connect MCP
3. Claude can now take snapshots, click elements, view console/network, run scripts

### Capabilities

- `take_snapshot` - Page accessibility tree
- `take_screenshot` - Capture visuals
- `click` / `fill` - Interact with elements
- `list_console_messages` - View logs
- `list_network_requests` - Monitor traffic
- `evaluate_script` - Run JavaScript
- `performance_start_trace` - Profile performance

## Dev-Mode Gotchas (`pnpm dev`)

Two dev-only failure modes look like extension bugs but are environment skew:

- **Zombie dev server / port drift.** Killing `pnpm dev` on Windows often orphans the node child,
  which keeps holding port 3000. `pnpm dev` now fails fast in that case
  (`scripts/assert-dev-port-free.mjs`) instead of letting WXT drift to 3001: the extension already
  loaded in the persistent profile keeps its old manifest CSP pinned to the previous port, which
  CSP-blocks every extension page script (blank popup) while the dev server serves from the new
  port.
- **Stale service worker.** WXT reloads the extension over CDP after relaunch/rebuild, and that
  reload sometimes fails silently
  (`CDP connection closed before response to Extensions.loadUnpacked`). The service worker then
  keeps running an old build while content scripts are current. Symptom: playing videos stay
  permanently whole-blurred while verdict statuses still update, because the old worker returns
  frame predictions without `timestampSec` and the VerdictTrack can never match them to frames — the
  content script logs `Frame prediction arrived without timestampSec` when this happens. Fix: reload
  the extension at `chrome://extensions`.

Production builds install a consistent worker + content pair, so neither issue exists outside
`pnpm dev`.
