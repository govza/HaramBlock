# Message Channel Transport

This document describes the cross-browser messaging architecture for HaramBlock, which uses two
different transport mechanisms optimized for Chrome and Firefox.

## Overview

HaramBlock uses **comctx** (RPC library) with adaptive transport selection:

- **Chrome**: MessageChannel with ImageBitmap (zero-copy transfer) + WebGPU inference
- **Firefox**: Blob transfer via browser.runtime (structured clone) + WebGL inference

The system automatically selects the optimal transport based on browser.

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

### MessageMeta Interface

```typescript
interface MessageMeta {
  url: string; // Content script's document.location.href
  tabId?: number; // Set by browser.runtime (sender.tab.id) or resolved by background
  injector?: 'content' | 'popup'; // Identifies the caller context
}
```

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
9. Inference runs with WebGPU backend (~80ms)
10. Response sent back via same MessageChannel port

**Data Flow**:

```
Content: fetch() → Blob → ImageBitmap (decode once)
Transfer: ImageBitmap ──────────────► (zero-copy, ~0MB)
Background: ImageBitmap → tensor (WebGPU inference)
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
9. Inference runs with WebGL backend (~190ms)
10. Response sent back via `browser.tabs.sendMessage()`

**Fallback** (url - on fetch/CORS errors):

- Content sends URL only (~200 bytes)
- Background fetches image with `cache: 'force-cache'` (cache hit ~7ms)

**Data Flow** (blob):

```
Content: fetch() → Blob
Transfer: Blob ──────────────► (structured clone, data copied)
Background: Blob → ImageBitmap → tensor (WebGL inference)
```

### Image Transfer Types

```typescript
// Chrome primary: ImageBitmap via MessageChannel (zero-copy)
interface IImageWithBitmap {
  kind: 'bitmap';
  bitmap: ImageBitmap;
  src: string;
  width: number;
  height: number;
  hostname: string;
  metadata: IImageMetadata;
}

// Firefox primary: Blob via browser.runtime (structured clone)
interface IImageWithBlob {
  kind: 'blob';
  blob: Blob;
  // ... same fields
}

// Fallback for both: URL only, background fetches from cache
interface IImageWithUrl {
  kind: 'url';
  src: string;
  width: number;
  height: number;
  hostname: string;
  metadata: IImageMetadata;
}
```

### Transfer Kind Configuration

`IMAGE_TRANSFER_KIND` (`utils/constants/environment.ts`) controls how images are sent:

```typescript
// Browser detection
export const IS_CHROME = import.meta.env.CHROME === true;

// Chrome: bitmap primary, url fallback (NEVER blob)
type ChromeImageTransferKind = 'bitmap' | 'url';
// Firefox: blob primary, url fallback (NEVER bitmap)
type FirefoxImageTransferKind = 'blob' | 'url';

// Default based on browser capability
export const IMAGE_TRANSFER_KIND = IS_CHROME ? 'bitmap' : 'blob';
export const IMAGE_FALLBACK_KIND = 'url'; // Same for both browsers
```

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

`HybridInjectAdapter` (`utils/messaging/adapters/hybridInjectAdapter.ts`) decides:

```typescript
if (USE_MESSAGE_CHANNEL && hasTransferables && channelAdapter) {
  // Chrome with transferables: MUST use MessageChannel
  // Wait for channel if not ready - runtime fallback would cause DataCloneError
  if (!channelAdapter.isAvailable()) {
    await channelAdapter.waitForReady(); // Has 15s timeout
  }
  return channelAdapter.sendMessage(message, transfer);
}
// Firefox or no transferables → browser.runtime
return runtimeAdapter.sendMessage(message, transfer);
```

**Important**: When Chrome has transferables (ImageBitmap), we **must** wait for MessageChannel.
Falling back to `browser.runtime` would cause a `DataCloneError` because ImageBitmap isn't
serializable without a transfer list.

### MessageChannel Timeout Protection

The MessageChannel has multiple timeout layers to prevent hanging:

| Location                       | Timeout | Purpose                   |
| ------------------------------ | ------- | ------------------------- |
| `initialize()` race            | 3s      | Quick availability check  |
| `establishChannel()` READY ACK | 10s     | SW acknowledgment timeout |
| `waitForReady()`               | 15s     | Hard timeout for callers  |

## RPC Protocol (comctx)

comctx provides type-safe RPC calls that look like local method invocations:

```typescript
// Content script
const settings = await backgroundRpc.getHostSettings(hostname);
const predictions = await backgroundRpc.getCachedPredictions(hostname);
await backgroundRpc.postInferenceImage(imageData);

// Subscriptions (callbacks)
const subscriptionId = await backgroundRpc.onInferencePredictions(data => {
  console.log('Received predictions:', data.predictions);
});
// Later: cleanup
await backgroundRpc.offInferencePredictions(subscriptionId);
```

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

```typescript
// Host settings
getHostSettings(hostname: string): Promise<IHostSettings>

// Image cache
getCachedPredictions(hostname: string): Promise<IImagePrediction[]>

// Image inference
// Chrome: receives ImageBitmap (kind: 'bitmap')
// Firefox: receives URL only (kind: 'url'), fetches from cache
postInferenceImage(imageData: IImageTransfer): Promise<void>

// Extension icon (RpcContext auto-injected by adapter, see "RpcContext" section)
updateIcon(hostname: string): Promise<void>

// Notify content scripts of settings changes
notifyHostSettingsChanged(hostname: string): void
```

### Subscription Methods

```typescript
// Subscribe to host settings updates
onHostSettingsUpdated(callback: (hostname: string) => void): string
offHostSettingsUpdated(subscriptionId: string): void

// Subscribe to inference predictions
onInferencePredictions(callback: (data: { predictions, hostname }) => void): string
offInferencePredictions(subscriptionId: string): void
```

**Note**: Subscription methods return IDs (not functions) because functions can't be serialized over
MessageChannel. Use the corresponding `off*` methods to unsubscribe.

### Subscription Cleanup Pattern

Content script listeners use a flag-based pattern for reliable cleanup:

```typescript
export function onImagePredictions(callback): () => void {
  let isActive = true;
  let subscriptionId: string | null = null;

  void (
    backgroundRpc.onInferencePredictions(data => {
      if (isActive) {
        callback(data); // Guard prevents stale callbacks
      }
    }) as unknown as Promise<string>
  ).then(id => {
    subscriptionId = id;
    if (!isActive) {
      // Cleanup if already unsubscribed while waiting
      void backgroundRpc.offInferencePredictions(id);
    }
  });

  return () => {
    isActive = false; // Immediately stops callback execution
    if (subscriptionId) {
      void backgroundRpc.offInferencePredictions(subscriptionId);
    }
  };
}
```

This handles both scenarios:

- **Early cleanup** (before promise resolves): `isActive=false` prevents callbacks, `.then()` cleans
  up
- **Normal cleanup** (after promise resolves): Cleans up immediately with the subscription ID

### Prediction Hostname Filtering

Predictions are broadcast to all subscribers, so content scripts filter by hostname:

```typescript
// MediaPipeline.ts
const unsubImagePreds = onImagePredictions(data => {
  if (data.hostname === this.opts.hostSettings.hostname) {
    this.onImagePredictions(data.predictions);
  }
});
```

## Performance Comparison

### Chrome (MessageChannel + WebGPU)

| Step                   | Time      | Notes             |
| ---------------------- | --------- | ----------------- |
| Content fetch + bitmap | ~10ms     | Decode in content |
| Transfer ImageBitmap   | ~0ms      | Zero-copy!        |
| Inference (WebGPU)     | ~80ms     | GPU accelerated   |
| **Total**              | **~90ms** |                   |

### Firefox (Blob + WebGL)

| Step                 | Time       | Notes                 |
| -------------------- | ---------- | --------------------- |
| Content fetch + blob | ~10ms      | Fetch in content      |
| Transfer Blob        | varies     | Structured clone copy |
| createImageBitmap    | ~4ms       | Decode in background  |
| Inference (WebGL)    | ~190ms     | GPU accelerated       |
| **Total**            | **~210ms** |                       |

### Why Firefox is Slower

1. **WebGL vs WebGPU**: Firefox's WebGPU is immature (~430ms), WebGL is faster (~190ms)
2. **Still ~2x slower than Chrome**: Browser-level GPU implementation differences

## Implementation Details

### Chrome MessageChannel Setup

1. **Iframe Injection** (`MessageChannelInjectAdapter`):
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

**browser.runtime path** (`CompositeProvideAdapter.initializeBrowserRuntime`):

```typescript
const enrichedMessage = {
  ...message,
  meta: {
    ...message.meta,
    tabId: sender.tab?.id, // From browser.runtime sender context
    url: sender.tab?.url || sender.url || '',
    _transport: 'runtime'
  }
};
```

**MessageChannel path** (`CompositeProvideAdapter.handlePortMessage`):

```typescript
const enrichedMessage = {
  ...data,
  meta: {
    ...data.meta,
    _channelSecret: secret, // For routing responses
    _transport: 'channel',
    url: data.meta?.url || '' // From content script
    // tabId not available - resolved by querying tabs
  }
};
```

### RpcContext — Exposing Sender Tab ID to Handlers

comctx's `createProvide` only passes explicit method arguments to handlers — the enriched message
meta (which contains `tabId`) is not exposed. `CompositeProvideAdapter` uses a request-scoped module
variable (`utils/messaging/rpcContext.ts`) to surface sender context to handlers without mutating
argument lists.

The `onMessage` wrapper calls `setRpcContext({ tabId })` before comctx dispatches. Since JS is
single-threaded, handlers read `getRpcContext()` synchronously before any `await` and get the
correct value.

```typescript
// Caller (content script) — unchanged, no extra args:
await backgroundRpc.updateIcon("example.com");

// Handler (background) — reads context from module variable:
async updateIcon(hostname: string): Promise<void> {
  const { tabId } = getRpcContext(); // must read before any await
  if (!tabId) return;
  await this.iconService.updateIconForTab(tabId, hostname);
}
```

On the MessageChannel path, `tabId` is undefined because raw ports don't carry sender context —
methods that require it no-op.

## Usage

### Content Script

```typescript
import { backgroundRpc } from '@/utils/messaging/content';

// Request-response
const settings = await backgroundRpc.getHostSettings(hostname);
await backgroundRpc.postInferenceImage(imageData);

// Subscriptions
const cleanup = onImagePredictions(({ predictions }) => {
  /* ... */
});
```

### Background

```typescript
import { provideBackgroundRpc, CompositeProvideAdapter } from '@/utils/messaging';

const rpc = provideBackgroundRpc(new CompositeProvideAdapter(), ...services);
```

## Security

- Secret-based pairing (crypto.randomUUID)
- Minimal web-accessible resources

## Adding New RPC Methods

Add method to `BackgroundRpc`, use in content via `backgroundRpc.methodName()`. comctx handles
everything automatically.

## Known Issues

1. **Firefox WebGPU**: ~2x slower than WebGL, so we use WebGL
2. **SW dormancy**: MessagePorts close when service worker sleeps, re-established on next call

## References

- [comctx](https://github.com/molvqingtai/comctx) - Cross-context RPC library
