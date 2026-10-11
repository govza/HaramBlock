import { IS_CHROME } from '@/utils/constants/environment';
import {
  LOOKAHEAD_HOST_PAGE,
  LOOKAHEAD_PORT_NAME,
  MSE_HOOK_HANDSHAKE,
  type ContentToHost,
  type FirefoxPortMessage,
  type HookMessage,
  type HostToContent,
  type OpenAnalysis,
  type TapKind,
} from '@/utils/lookahead/protocol';
import { backgroundRpc } from '@/utils/messaging/content';
import { getLogger } from '@/utils/telemetry';

import type {
  AnalysisStat,
  InferredSample,
  Liveness,
  Playhead,
  StoredSample,
  UnreachableReason,
} from '@/utils/lookahead/ports';

const log = getLogger('lookaheadClient');

export interface LookaheadInferenceRequest {
  pointUs: number;
  bitmap: ImageBitmap;
  originalWidth: number;
  originalHeight: number;
  priority: number;
}

export interface LookaheadHandlers {
  reachable(tap: Exclude<TapKind, 'none'>): void;
  unreachable(reason: UnreachableReason): void;
  sample(sample: StoredSample): void;
  stat(stat: AnalysisStat): void;
  infer(request: LookaheadInferenceRequest): Promise<InferredSample | null>;
}

export interface LookaheadSession {
  setPlayhead(playhead: Playhead): void;
  setVisible(visible: boolean): void;
  setLiveness(liveness: Liveness): void;
  close(): void;
}

interface HostLink {
  send(message: ContentToHost, transfer?: Transferable[]): void;
}

let hookPort: MessagePort | null = null;
let hookAcknowledged = false;
let listeningToHook = false;
let link: HostLink | null = null;
const sessions = new Map<string, { open: OpenAnalysis; handlers: LookaheadHandlers }>();

function offerHookPort(): void {
  const channel = new MessageChannel();
  hookPort?.close();
  hookPort = channel.port1;
  hookAcknowledged = false;
  globalThis.window.postMessage({ [MSE_HOOK_HANDSHAKE]: 'port' }, '*', [channel.port2]);
}

export function connectMseHook(): void {
  if (hookPort) return;
  if (!listeningToHook) {
    listeningToHook = true;
    globalThis.window.addEventListener('message', event => {
      if (event.source !== globalThis.window) return;
      const signal = (event.data as Record<string, unknown> | null)?.[MSE_HOOK_HANDSHAKE];
      if (signal === 'ack') hookAcknowledged = true;
      if (signal === 'ready' && !hookAcknowledged && !link) offerHookPort();
    });
  }
  offerHookPort();
}

function hookPortOrNew(): MessagePort {
  if (!hookPort) connectMseHook();
  return hookPort as MessagePort;
}

function onHostMessage(message: HostToContent): void {
  if (message.t === 'toHook') {
    hookPort?.postMessage(message.command);
    return;
  }
  if (message.t === 'cacheRead') {
    const session = sessions.get(message.sessionId);
    void readCache(session?.open).then(samples =>
      link?.send({ t: 'cacheSamples', requestId: message.requestId, samples }),
    );
    return;
  }
  const session = sessions.get(message.sessionId);
  if (!session) {
    if (message.t === 'infer') message.bitmap.close();
    return;
  }
  const { handlers, open } = session;
  switch (message.t) {
    case 'reachable':
      handlers.reachable(message.tap);
      break;
    case 'unreachable':
      handlers.unreachable(message.reason);
      break;
    case 'sample':
      handlers.sample(message.sample);
      break;
    case 'stat':
      handlers.stat(message.stat);
      break;
    case 'infer':
      void handlers
        .infer(message)
        .catch(() => null)
        .then(sample => link?.send({ t: 'inferResult', requestId: message.requestId, sample }));
      break;
    case 'cachePublish':
      void backgroundRpc
        .publishVideoSamples(open.cacheKey, { sourceUrl: open.sourceUrl, hostname: open.hostname }, message.samples)
        .catch((error: unknown) => log.debug('lookahead.cache.publish_failed', { error }));
      break;
  }
}

async function readCache(open: OpenAnalysis | undefined): Promise<StoredSample[]> {
  if (!open?.cacheKey) return [];
  try {
    return (await backgroundRpc.getCachedVideoPredictions(open.cacheKey)).samples;
  } catch (error) {
    log.debug('lookahead.cache.read_failed', { error });
    return [];
  }
}

function connectChromeHost(): HostLink {
  const secret = crypto.randomUUID();
  const channel = new MessageChannel();
  const url = new URL(browser.runtime.getURL(LOOKAHEAD_HOST_PAGE));
  url.searchParams.set('secret', secret);
  const container = document.createElement('div');
  const root = container.attachShadow({ mode: 'closed' });
  const iframe = document.createElement('iframe');
  iframe.hidden = true;
  root.appendChild(iframe);
  iframe.addEventListener(
    'load',
    () => iframe.contentWindow?.postMessage(secret, url.origin, [channel.port2, hookPortOrNew()]),
    { once: true },
  );
  iframe.src = url.toString();
  (document.body || document.documentElement).appendChild(container);
  channel.port1.onmessage = (event: MessageEvent<HostToContent>) => onHostMessage(event.data);
  return { send: (message, transfer = []) => channel.port1.postMessage(message, transfer) };
}

function connectFirefoxHost(): HostLink {
  const port = browser.runtime.connect({ name: LOOKAHEAD_PORT_NAME });
  const post = (message: FirefoxPortMessage) => {
    try {
      port.postMessage(message);
    } catch (error) {
      log.debug('lookahead.port.post_failed', { error });
    }
  };
  port.onMessage.addListener(raw => onHostMessage(raw as HostToContent));
  port.onDisconnect.addListener(() => {
    link = null;
    offerHookPort();
    for (const { handlers } of sessions.values()) handlers.unreachable('hook');
    sessions.clear();
  });
  hookPortOrNew().onmessage = (event: MessageEvent<HookMessage>) => post({ k: 'hook', m: event.data });
  return { send: message => post({ k: 'content', m: message }) };
}

function hostLink(): HostLink {
  link ??= IS_CHROME ? connectChromeHost() : connectFirefoxHost();
  return link;
}

export function openLookahead(open: OpenAnalysis, handlers: LookaheadHandlers): LookaheadSession {
  sessions.set(open.sessionId, { open, handlers });
  const host = hostLink();
  host.send(open);
  return {
    setPlayhead: playhead => link?.send({ t: 'playhead', sessionId: open.sessionId, playhead }),
    setVisible: visible => link?.send({ t: 'visible', sessionId: open.sessionId, visible }),
    setLiveness: liveness => link?.send({ t: 'liveness', sessionId: open.sessionId, liveness }),
    close: () => {
      if (!sessions.delete(open.sessionId)) return;
      link?.send({ t: 'close', sessionId: open.sessionId });
    },
  };
}
