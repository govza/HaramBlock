# Message Channel Transport

This document describes the cross-browser messaging architecture for HaramBlock, which uses two
different transport mechanisms optimized for Chrome and Firefox.

## Overview

HaramBlock uses **comctx** (RPC library) with adaptive transport selection:

- **Chrome**: MessageChannel with ImageBitmap (zero-copy transfer)
- **Firefox**: Blob transfer via browser.runtime (structured clone)

The system automatically selects the optimal transport based on browser. Inference backend selection
is separate: ONNX Runtime tries WebGPU first when `navigator.gpu` exists, then falls back to WASM.

### Browser-Specific Transfer Rules

| Content Type | Chrome Primary | Chrome Fallback | Firefox Primary | Firefox Fallback |
| ------------ | -------------- | --------------- | --------------- | ---------------- |
| Images       | `bitmap`       | `url`           | `blob`          | `url`            |
| Video Frames | `bitmap`       | _(throws)_      | `blob`          | _(none)_         |

**Key constraints enforced by the type system:**

- Chrome NEVER sends blobs (defeats MessageChannel purpose)
- Firefox NEVER sends bitmaps (no MessageChannel support)
- Video frames have no URL fallback (generated in content script, not fetchable)

### Architecture Roles

- **Content Script**: Initiates communication, sends image data for inference
- **Injected iframe** (Chrome only): Bridges MessageChannel to service worker
- **Background Service Worker**: Receives RPC calls via BackgroundRpc service
- **comctx Adapters**: Handle transport selection and routing automatically

## Message Meta and Tab ID Resolution

Following the **comctx pattern**, content scripts include their URL in message metadata, and the
background resolves tab context when needed by querying tabs.

### MessageMeta

`MessageMeta` (`utils/messaging/adapters/browserRuntimeAdapter.ts`) carries three fields: `url` (the
content script's `document.location.href`), an optional `tabId` (set by browser.runtime from
`sender.tab.id`, or resolved by the background), and an optional `injector` tag (`'content'` or
`'popup'`) identifying the caller context.

### How Meta Flows Through the System

1. **Content script sends message**:
   - Adapters automatically enrich with `meta: { url: document.location.href, injector: 'content' }`

2. **Background receives message**:
   - `browser.runtime` path: `CompositeProvideAdapter` adds `tabId` from `sender.tab.id`
   - `MessageChannel` path: No sender context, but URL is available in meta

### Why This Pattern?

- **Follows comctx conventions**: URL-based identification, not explicit tab ID passing
- **No chicken-and-egg problem**: Content doesn't need to know its tab ID upfront
- **Works for both transports**: browser.runtime has sender context, MessageChannel uses URL lookup
- **Predictions are broadcast**: Results go to all subscribers matching the hostname

## Transport Variants

### Chrome Path (MessageChannel + ImageBitmap)

**Why**: Zero-copy transfer of large image data (saves ~25MB per image)

**Flow**:

1. Content script calls `backgroundRpc.postInferenceImage(imageData)` with `kind: 'bitmap'`
2. `HybridInjectAdapter` detects transferables → waits for MessageChannel if needed
3. `MessageChannelInjectAdapter` injects iframe (`public/message-channel.html`)
4. Iframe loads, content creates `MessageChannel` and transfers `port2` to iframe
5. Iframe posts port to service worker via `navigator.serviceWorker.ready`
6. Service worker's `CompositeProvideAdapter` receives port and ACKs with `{ type: 'READY' }`
7. comctx sends RPC call with ImageBitmap as transferable (zero-copy!)
8. `CompositeProvideAdapter` routes to `BackgroundRpc.postInferenceImage()`
9. Inference runs with the active ONNX backend (WebGPU first, WASM fallback)
10. Response sent back via same MessageChannel port

**Data Flow**:

```
Content: fetch() → Blob → ImageBitmap (decode once)
Transfer: ImageBitmap ──────────────► (zero-copy, ~0MB)
Background: ImageBitmap → tensor → ONNX inference
```

### Firefox Path (Blob Primary, URL Fallback)

**Why**: No MessageChannel support; uses blob transfer via structured clone

**Flow** (primary - blob):

1. Content script calls `backgroundRpc.postInferenceImage(imageData)` with `kind: 'blob'`
2. `HybridInjectAdapter` detects Firefox → routes via `InjectAdapter('content')`
3. Content fetches image and creates Blob
4. comctx sends RPC call via `browser.runtime.sendMessage()` with Blob
5. `CompositeProvideAdapter` receives via `browser.runtime.onMessage`
6. Message enriched with `tabId` from `sender.tab.id`
7. Routes to `BackgroundRpc.postInferenceImage()`
8. Background creates ImageBitmap from Blob
9. Inference runs with the active ONNX backend (WebGPU first when available, otherwise WASM)
10. Response sent back via `browser.tabs.sendMessage()`

**Fallback** (url - on fetch/CORS errors):

- Content sends URL only (~200 bytes)
- Background fetches image with `cache: 'force-cache'` (cache hit ~7ms)

**Data Flow** (blob):

```
Content: fetch() → Blob
Transfer: Blob ──────────────► (structured clone, data copied)
Background: Blob → ImageBitmap → tensor → ONNX inference
```

### Image Transfer Types

`IImageTransfer` (`utils/types/media.ts`) is a discriminated union on `kind`: `IImageWithBitmap`
(Chrome primary — ImageBitmap via MessageChannel, zero-copy), `IImageWithBlob` (Firefox primary —
Blob via browser.runtime, structured clone), and `IImageWithUrl` (fallback for both — URL only, the
background fetches from cache). All variants share the base fields (src, dimensions, hostname,
metadata).

### Transfer Kind Configuration

`IMAGE_TRANSFER_KIND` (`utils/constants/environment.ts`) controls how images are sent. It defaults
by browser: `bitmap` on Chrome, `blob` on Firefox, with `IMAGE_FALLBACK_KIND` fixed to `url` for
both. Per-browser union types (`bitmap | url` for Chrome, `blob | url` for Firefox) make the
forbidden combinations unrepresentable.

| Kind     | Transport       | Overhead             | Browser      |
| -------- | --------------- | -------------------- | ------------ |
| `bitmap` | MessageChannel  | ~0 bytes (zero-copy) | Chrome only  |
| `blob`   | browser.runtime | image size (copied)  | Firefox only |
| `url`    | browser.runtime | ~200 bytes           | Both         |

**Fallback behavior**:

- **Chrome**: If `bitmap` transfer fails (MessageChannel unavailable), falls back to `url`
- **Firefox**: If `blob` transfer fails (fetch/CORS error), falls back to `url`

**Key constraint**: Chrome never falls back to `blob` - this would defeat the purpose of
MessageChannel. The type system enforces this separation.

**Testing different modes**: Change `IMAGE_TRANSFER_KIND` in `utils/constants/environment.ts`.
Runtime validation throws if you set an invalid kind for the browser (e.g., `bitmap` on Firefox).

### Transport Selection Logic

`HybridInjectAdapter` (`utils/messaging/adapters/hybridInjectAdapter.ts`) decides per send: on
Chrome with transferables it lazily creates the channel adapter and sends over MessageChannel,
waiting for the channel to become ready first (15s hard timeout); Firefox and transferable-free
messages go via browser.runtime.

**Important**: When Chrome has transferables (ImageBitmap), we **must** wait for MessageChannel.
Falling back to `browser.runtime` would cause a `DataCloneError` because ImageBitmap isn't
serializable without a transfer list.

**Deferred initialization**: The `MessageChannelInjectAdapter` is not created in the
`HybridInjectAdapter` constructor. Instead, the content script's `main()` first checks
`document.contentType` — on non-HTML/image pages (PDF, XML, JSON, plain text) it returns early. On
supported pages, it calls `warmupMessageChannel()` which triggers `getChannelAdapter()` to create
the adapter and start the iframe/service-worker handshake. This keeps normal page startup timing
unchanged while avoiding timeouts on pages where the relay can't reach the service worker. Any
`onMessage` callbacks registered before the adapter exists are queued and replayed when it is
created.

### MessageChannel Timeout Protection

The MessageChannel has multiple timeout layers to prevent hanging:

| Location                       | Timeout | Purpose                   |
| ------------------------------ | ------- | ------------------------- |
| `initialize()` race            | 3s      | Quick availability check  |
| `establishChannel()` READY ACK | 10s     | SW acknowledgment timeout |
| `waitForReady()`               | 15s     | Hard timeout for callers  |

## RPC Protocol (comctx)

comctx provides type-safe RPC calls that look like local method invocations: content code calls
methods on the `backgroundRpc` proxy (request-response like `getHostSettings`, fire-and-forget like
`postInferenceImage`, and subscription pairs like `onInferencePredictions` /
`offInferencePredictions`) and comctx handles the messaging.

**Under the hood**, comctx serializes method calls into messages with:

- Method name
- Arguments
- Request ID (for correlating responses)
- Metadata (url, injector, transport hints)

No manual request/response correlation needed!

## Key Files

### Content Script

- **RPC Client**: `utils/messaging/content.ts`
  - Exports `backgroundRpc` singleton using `HybridInjectAdapter`
- **Senders**: `entrypoints/content/communication/sender.ts`
  - High-level helpers: `requestHostSettings()`, `requestImageInference()`, etc.
- **Listeners**: `entrypoints/content/communication/listener.ts`
  - Subscription wrappers: `onHostSettingsUpdated()`, `onImagePredictions()`

### Background Service Worker

- **RPC Service**: `utils/messaging/services/backgroundRpc.ts`
  - `BackgroundRpc` class with all RPC methods
- **Initialization**: `entrypoints/background/index.ts`
  - `provideBackgroundRpc(new CompositeProvideAdapter(), ...services)`

### Adapters

- **HybridInjectAdapter**: `utils/messaging/adapters/hybridInjectAdapter.ts`
  - Content-side: Routes based on browser + transferables
- **CompositeProvideAdapter**: `utils/messaging/adapters/compositeProvideAdapter.ts`
  - Background-side: Handles both MessageChannel and browser.runtime
- **MessageChannelInjectAdapter**: `utils/messaging/adapters/messageChannelAdapter.ts`
  - Chrome content-side: Manages iframe injection and port transfer
- **InjectAdapter/ProvideAdapter**: `utils/messaging/adapters/browserRuntimeAdapter.ts`
  - browser.runtime messaging wrappers

### MessageChannel Bridge (Chrome only)

- **Injected iframe**: `public/message-channel.html` + `public/message-channel.js`
  - Bridges content MessageChannel to service worker
- **Manifest**: `wxt.config.ts` → `manifest.web_accessible_resources`

## BackgroundRpc Service Methods

`BackgroundRpc` (`utils/messaging/services/backgroundRpc.ts`) exposes these RPC methods:

### Request-Response Methods

- `getHostSettings` — per-host settings lookup
- `getCachedPredictions` — cached predictions for a hostname
- `postInferenceImage` — submits an `IImageTransfer` for inference (Chrome sends a bitmap, Firefox a
  blob/url; the verdict arrives later on the results broadcast)
- `updateIcon` — extension icon update (RpcContext auto-injected by adapter, see "RpcContext"
  section)
- `notifyHostSettingsChanged` — pushes settings changes to content scripts

### Subscription Methods

`on*` / `off*` pairs (e.g. `onHostSettingsUpdated`, `onInferencePredictions`): the `on*` method
registers a callback and returns a subscription ID string; the matching `off*` method unsubscribes
by ID.

**Note**: Subscription methods return IDs (not functions) because functions can't be serialized over
MessageChannel. Use the corresponding `off*` methods to unsubscribe.

### Subscription Cleanup Pattern

Content script listeners (`entrypoints/content/communication/listener.ts`) use a flag-based pattern
for reliable cleanup: the wrapper sets an `isActive` flag, guards the registered callback on it,
records the subscription ID when the `on*` promise resolves, and returns an unsubscribe function
that flips the flag and calls `off*`.

This handles both scenarios:

- **Early cleanup** (before promise resolves): `isActive=false` prevents callbacks, `.then()` cleans
  up
- **Normal cleanup** (after promise resolves): Cleans up immediately with the subscription ID

### Prediction Hostname Filtering

Inference results are broadcast to all subscribers, so each content script filters by hostname:
`MediaPipeline` drops results whose `hostname` doesn't match its own host settings before handing
them to `ImageProcessor.handleInferenceResults`.

## Performance Comparison

### Chrome (MessageChannel + ONNX)

| Step                   | Time   | Notes             |
| ---------------------- | ------ | ----------------- |
| Content fetch + bitmap | ~10ms  | Decode in content |
| Transfer ImageBitmap   | ~0ms   | Zero-copy!        |
| Inference              | varies | WebGPU or WASM    |
| **Total**              | varies |                   |

### Firefox (Blob + ONNX)

| Step                 | Time   | Notes                 |
| -------------------- | ------ | --------------------- |
| Content fetch + blob | ~10ms  | Fetch in content      |
| Transfer Blob        | varies | Structured clone copy |
| createImageBitmap    | ~4ms   | Decode in background  |
| Inference            | varies | WebGPU or WASM        |
| **Total**            | varies |                       |

### Why Firefox is Slower

1. **Transport copy**: Firefox uses structured-clone blob transfer instead of zero-copy ImageBitmap
   transfer over MessageChannel.
2. **Backend availability**: Firefox without WebGPU runs ONNX on WASM; Firefox WebGPU uses the
   queue-poking workaround documented in `docs/MODEL.md`.

## Implementation Details

### Chrome MessageChannel Setup

1. **Iframe Injection** (`MessageChannelInjectAdapter`, deferred):
   - Adapter is created by `HybridInjectAdapter.warmupChannel()`, called from content script
     `main()` after the `contentType` gate passes (skipped on PDF/XML/JSON/plain text pages)
   - Creates hidden iframe with web-accessible URL + secret query param
   - Waits for iframe load
   - Creates `MessageChannel`, transfers `port2` to iframe

2. **Iframe Bridge** (`public/message-channel.js`):
   - Receives `port2` via `window.addEventListener('message')`
   - Gets service worker: `await navigator.serviceWorker.ready`
   - Posts `{ type: 'PORT_READY', secret }` to SW with transferred port

3. **Background Receiver** (`CompositeProvideAdapter`):
   - Listens on `globalThis.addEventListener('message')`
   - On `PORT_READY`: stores port by secret
   - Wires `port.onmessage` to comctx message handler
   - ACKs with `{ type: 'READY' }` to signal readiness

4. **Message Routing**:
   - All RPC calls via this port include `meta._channelSecret` for routing
   - Responses automatically sent back via same port
   - Handles port cleanup on tab close/reload

### Meta Enrichment by Transport

**browser.runtime path** (`CompositeProvideAdapter.initializeBrowserRuntime`): enriches meta with
`tabId` and `url` from the browser.runtime sender context, and tags `_transport: 'runtime'`.

**MessageChannel path** (`CompositeProvideAdapter.handlePortMessage`): enriches meta with the
channel secret (for routing responses) and tags `_transport: 'channel'`. The `url` comes from the
content script's own meta; `tabId` is not available on this path and is resolved by querying tabs
when needed.

### RpcContext — Exposing Sender Tab ID to Handlers

comctx's `createProvide` only passes explicit method arguments to handlers — the enriched message
meta (which contains `tabId`) is not exposed. `CompositeProvideAdapter` uses a request-scoped module
variable (`utils/messaging/rpcContext.ts`) to surface sender context to handlers without mutating
argument lists.

The `onMessage` wrapper calls `setRpcContext({ tabId })` before comctx dispatches. Since JS is
single-threaded, handlers read `getRpcContext()` synchronously before any `await` and get the
correct value. Callers are unchanged (no extra arguments); handlers that need the sender tab (e.g.
`updateIcon`) read it from the context and no-op when it's absent.

On the MessageChannel path, `tabId` is undefined because raw ports don't carry sender context —
methods that require it no-op.

## Usage

Content scripts import the `backgroundRpc` singleton from `utils/messaging/content.ts` and call its
methods directly; subscriptions go through the wrappers in
`entrypoints/content/communication/listener.ts`, which return cleanup functions. The background side
registers the service once at startup via `provideBackgroundRpc` with a `CompositeProvideAdapter`
(`entrypoints/background/index.ts`).

## Channel Death and Instance Lifecycle

The channel dies in two distinct ways, and the content script reacts differently to each:

1. **Service-worker idle kill** (same instance, context still valid): the SW's end of the channel is
   disentangled and the port `close` event fires. The adapter only marks the channel dead
   (`resetState()`); the next send lazily re-establishes it. Nothing is torn down.
2. **Extension context invalidated** (reload, update, disable, removal): channel establishment
   itself fails because `browser.runtime` APIs throw. The adapter surfaces this as a permanent-death
   event (`onMessageChannelPermanentDeath` in `utils/messaging/content.ts`), which the content
   script's `InstanceLifecycle` (`entrypoints/content/lifecycle/`) consumes to fail open: dispose
   all video sessions, stop the pipeline, and strip pre-verdict styling.

Orphaned instances are additionally detected by a pure-DOM supersede sentinel: each instance stamps
a nonce onto `<html data-haramblock-instance>` at startup and observes it. When a successor instance
(injected after an extension reload/update) stamps its own nonce, every earlier instance tears
itself down — this works even though the orphan's extension APIs all throw. The successor also
sweeps overlay elements a crashed predecessor left behind before attaching media itself.

**Coverage limits.** Neither signal is exhaustive. The permanent-death event only fires when a
channel establishment attempt fails, i.e. on the orphan's next send — a page whose media all settled
before the invalidation never sends again and keeps whatever pre-verdict styling it had. And in
production Chrome does not re-inject content scripts into open tabs on extension update, so no
successor stamps the sentinel there; the sentinel path covers dev (WXT re-injects) and any future
explicit re-injection on update. Pages with active video sessions are always covered: the sampler
keeps sending, which forces an establishment attempt and the death event.

## Security

- Secret-based pairing (crypto.randomUUID)
- Minimal web-accessible resources

## Adding New RPC Methods

Add method to `BackgroundRpc`, use in content via `backgroundRpc.methodName()`. comctx handles
everything automatically.

## Known Issues

1. **Firefox transport**: blob transfer copies data, so it is slower than Chrome's zero-copy
   MessageChannel path
2. **SW dormancy**: MessagePorts close when service worker sleeps, re-established on next call

## References

- [comctx](https://github.com/molvqingtai/comctx) - Cross-context RPC library
