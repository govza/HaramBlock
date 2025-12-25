# AI-Assisted Development Setup

This guide covers the setup of AI tools for developing and debugging the HaramBlock browser
extension.

## Chrome DevTools MCP

Enables Claude to interact with Chrome browser sessions for debugging and testing.

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
