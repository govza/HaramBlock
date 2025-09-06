# Message Channel Transport

This document describes the current MessageChannel-based transport used to enable passing
transferables (e.g., ImageBitmap, ArrayBuffer, Blob) between the content script and the background
context, without relying on chrome.runtime messaging for large payloads. It also outlines caveats
and concrete next steps to complete the integration.

## Overview

- Roles:
  - A: Content script (initiates the channel, sends/receives heavy data)
  - B: Injected iframe + script (web‑accessible page used to bridge into the SW)
  - C: Background service worker (receives the transferred port and processes messages)

- Goal: Establish a direct two‑way MessageChannel so A can send transferables efficiently to C.

## Current Flow

1. Content script creates a secret and injects a hidden iframe that loads a web‑accessible page with
   that secret in the query string.
   - `entrypoints/content/communication/message-channel.ts`
2. After the iframe loads, content creates a `MessageChannel` and posts the secret to the iframe,
   transferring `port2`.
3. The injected page receives the secret and calls `navigator.serviceWorker.ready`, then posts a
   message to the active service worker transferring the received port along with
   `{ type: 'PORT_READY', secret }`.
   - `public/message-channel.html`
   - `public/message-channel.js`
4. The content script waits for the first message on `port1` to confirm the tunnel is ready, then
   removes the iframe and returns `port1` to callers.
5. Large payloads can then flow over this port using the standard `MessagePort` API.

## Typed Protocol

To make messages easy to route and safe to evolve, the channel uses a small typed protocol:

- Request: `{ id: string, type: 'request', action: string, payload: any }`
- Response:
  `{ id: string, type: 'response', action: '<action>-result', success: boolean, payload?, error? }`

Helpers and type guards live in:

- `utils/messaging/channelTypes.ts`
  - `ChannelRequest`, `ChannelResponse`, `ChannelMessage`
  - `isChannelRequest`, `isChannelResponse`
  - Control init message: `ChannelReady` (`{ type: 'READY' }`)

## Files

- Content helper (creates the channel, injects iframe):
  - `entrypoints/content/communication/message-channel.ts`
- Injected bridge page (web‑accessible):
  - `public/message-channel.html`
  - `public/message-channel.js`
- Manifest configuration (exposes the bridge page):
  - `wxt.config.ts` → `manifest.web_accessible_resources`

## Background Integration (Implemented)

- Controller: `entrypoints/background/controllers/messageChannelController.ts`
- Registered in background bootstrap: `entrypoints/background/index.ts`

Behavior:

- Listens for `message` events on the SW global scope.
- On `{ type: 'PORT_READY', secret }`, takes `event.ports[0]`, stores by `secret`.
- Immediately ACKs on the port with `{ type: 'READY' }` so content resolves.
- Wires `port.onmessage` for follow‑up messages (currently logs; to be routed next).

### Routing and Actions

- Switch-based router in background:
  - `entrypoints/background/controllers/messageChannelController.ts` → `handleRequest(...)`
  - Detects requests via `isChannelRequest(data)` and routes by `action`.
  - On connect, background sends a typed init ACK: `{ type: 'READY' }`.

## Caveats and Notes

- Service worker reachability: In MV3, an extension web‑accessible page can reach the extension’s
  background service worker via `navigator.serviceWorker.ready` and `swr.active.postMessage(...)`
  with transferables. This matches the working pattern in external references.
- SW lifetime: If the service worker stops, open MessagePorts are closed. We already keep it warm
  (see `entrypoints/background/events/keepAlive.ts`). Keep this in mind during development.
- Origin safety: When posting the `MessageChannel` to the iframe, prefer the specific origin instead
  of `'*'`.
- URL caching: A secret query param is appended to the iframe URL to avoid caching. Optionally set
  `use_dynamic_url: true` in the manifest entry.

## API Shape (Content)

`messageChannel(onMessage: (e: MessageEvent) => void): Promise<MessagePort>`

- Injects `message-channel` as an iframe (web‑accessible resource), transfers `port2`.
- Resolves after the SW replies once via the transferred port.
- Returns `port1` for callers to `postMessage(...)` transferables.

Recommended content helper wrapper (future):

- `sendCommand<T>(action, payload): Promise<T>` that
  - Creates a unique `id`
  - Posts a `ChannelRequest`
  - Resolves on matching `ChannelResponse` with same `id` and `<action>-result`

## Security Considerations

- Use a per‑tunnel `secret` to pair the content request with the injected page and the SW.
- Restrict `postMessage` target to `url.origin` instead of `'*'` when sending the port to the
  iframe.
- Only expose minimal web‑accessible resources required by this flow.

## Next Steps

1. Background routing to services (next):
   - Route messages coming over a tunnel `MessagePort` to the appropriate service (e.g., inference
     orchestration).
   - Define a minimal protocol (action/id/payload) for requests and results over the port.
   - Suggested actions to add:
     - `PROCESS_IMAGE`: payload includes `src`, `metadata`, optional `ImageBitmap` as transferable;
       response returns prediction result.
     - `CANCEL_TASK`: cancel by `id`.
     - `CACHE_GET` / `CACHE_PUT`: interact with prediction cache for the hostname.

2. Content helper hardening (non‑blocking):
   - Use `iframe.src = url.toString()` instead of mutating `contentWindow.location.href`.
   - Post the channel to the iframe using `url.origin` instead of `'*'`.
   - Optionally call `mc.port1.start()` when using `addEventListener('message', ...)`.
   - Fix minor typos in comments ("transferables").

3. Manifest polish (optional):
   - Add `use_dynamic_url: true` to the `web_accessible_resources` entry if desired.

4. Orchestration integration:
   - Decide where heavy work lives (background vs. offscreen document vs. dedicated worker started
     by the SW).
   - If needed, keep control messages on `chrome.runtime` and heavy payloads on the `MessagePort`.

5. Content `sendCommand` helper (nice‑to‑have):
   - Mirror the pattern from external references to correlate replies by `id` and simplify usage at
     call sites.

## How to Add a New Action

1. Define types in `utils/messaging/channelTypes.ts`:
   - Example: `export type ProcessImageAction = 'PROCESS_IMAGE';`
   - Add `type` aliases for request/response payloads if needed.
2. Implement routing in `entrypoints/background/controllers/messageChannelController.ts`:
   - Extend `handleRequest(...)` switch with a case for the new action.
   - Call into the appropriate service(s) and respond with a `ChannelResponse` using the same `id`.
3. From content, send a `ChannelRequest` over the returned `MessagePort`.
   - If using a `sendCommand` helper, await the resolved result by `id`.

## Testing Plan

- Handshake test: Verify content resolves after injected page posts to SW and SW ACKs back.
- Roundtrip test: Post a small message over the port and assert a typed response.
- Transferables test: Send an `ImageBitmap` or `ArrayBuffer` and validate processing on the
  background side.
- SW lifecycle: Simulate SW restart; confirm re‑establishment logic works as expected.

## References

- Internal: `entrypoints/content/communication/message-channel.ts`, `public/message-channel.*`,
  `entrypoints/background/events/keepAlive.ts`
- External pattern: Similar to the approach used in public examples that bridge a content
  MessageChannel through a web‑accessible page to the extension SW.
