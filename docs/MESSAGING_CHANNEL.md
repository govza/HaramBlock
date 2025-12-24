# Message Channel Transport

This document describes the cross-browser messaging architecture for HaramBlock, which uses two
different transport mechanisms optimized for Chrome and Firefox.

## Overview

HaramBlock uses **comctx** (RPC library) with adaptive transport selection:

- **Chrome MV3**: MessageChannel with ImageBitmap (zero-copy transfer) + WebGPU inference
- **Firefox MV2**: URL-only transfer (background fetches from cache) + WebGL inference

The system automatically selects the optimal transport and TensorFlow.js backend based on browser.

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

### Chrome MV3 Path (MessageChannel + ImageBitmap)

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

### Firefox MV2 Path (URL-only + Cache Fetch)

**Why**: Avoids blob serialization overhead; background fetches from browser cache

**Flow**:

1. Content script calls `backgroundRpc.postInferenceImage(imageData)` with `kind: 'url'`
2. `HybridInjectAdapter` detects Firefox → routes via `InjectAdapter('content')`
3. comctx sends RPC call via `browser.runtime.sendMessage()` with URL only (~200 bytes)
4. `CompositeProvideAdapter` receives via `browser.runtime.onMessage`
5. Message enriched with `tabId` from `sender.tab.id`
6. Routes to `BackgroundRpc.postInferenceImage()`
7. Background calls inference library with `kind: 'src'`
8. Inference library fetches image with `cache: 'force-cache'` (cache hit ~7ms)
9. Inference runs with WebGL backend (~190ms)
10. Response sent back via `browser.tabs.sendMessage()`

**Data Flow**:

```
Content: Send URL only (~200 bytes)
Transfer: URL string ──────────────► (minimal overhead)
Background: fetch(cache) → Blob → ImageBitmap → tensor (WebGL inference)
```

### Image Transfer Types

```typescript
// Chrome: ImageBitmap via MessageChannel (zero-copy)
interface IImageWithBitmap {
  kind: 'bitmap';
  bitmap: ImageBitmap;
  src: string;
  width: number;
  height: number;
  hostname: string;
  metadata: IImageMetadata;
}

// Firefox: URL only, background fetches from cache
interface IImageWithUrl {
  kind: 'url';
  src: string;
  width: number;
  height: number;
  hostname: string;
  metadata: IImageMetadata;
}

// Blob transfer (structured clone, ~25MB overhead)
interface IImageWithBlob {
  kind: 'blob';
  blob: Blob;
  // ... same fields
}
```

### Transfer Kind Configuration

`IMAGE_TRANSFER_KIND` (`utils/constants/environment.ts`) controls how images are sent:

```typescript
// Browser detection
export const IS_CHROME = import.meta.env.CHROME === true;

// Valid kinds per browser (enforced at runtime)
type ChromeTransferKind = 'bitmap' | 'blob' | 'url';
type FirefoxTransferKind = 'blob' | 'url';

// Default based on browser capability
export const IMAGE_TRANSFER_KIND = IS_CHROME ? 'bitmap' : 'url';
```

| Kind     | Transport       | Overhead                 | Browser     |
| -------- | --------------- | ------------------------ | ----------- |
| `bitmap` | MessageChannel  | ~0 bytes (zero-copy)     | Chrome only |
| `blob`   | browser.runtime | ~25MB (structured clone) | Both        |
| `url`    | browser.runtime | ~200 bytes               | Both        |

**Fallback behavior**: If `bitmap` is configured but MessageChannel is unavailable (timeout), the
sender automatically falls back to `url` mode. This ensures inference still works even if the
service worker hasn't established the MessageChannel yet.

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

## TensorFlow.js Backend Selection

Backend is selected based on browser for optimal performance:

```typescript
// utils/inference/modelLoader.ts
const IS_CHROME = import.meta.env.CHROME === true;
const PREFERRED_BACKEND = IS_CHROME ? 'webgpu' : 'webgl';
```

| Browser | Backend | Inference Time |
| ------- | ------- | -------------- |
| Chrome  | WebGPU  | ~80ms          |
| Firefox | WebGL   | ~190ms         |

Firefox's WebGPU implementation is ~2x slower than WebGL, so we use WebGL for better performance.

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

// Extension icon
updateIcon(hostname: string, tabId?: number): Promise<void>

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

### Firefox (URL + WebGL)

| Step              | Time       | Notes                |
| ----------------- | ---------- | -------------------- |
| Transfer URL      | ~0ms       | Just a string        |
| Background fetch  | ~7ms       | Cache hit            |
| createImageBitmap | ~4ms       | Decode in background |
| Inference (WebGL) | ~190ms     | GPU accelerated      |
| **Total**         | **~200ms** |                      |

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
