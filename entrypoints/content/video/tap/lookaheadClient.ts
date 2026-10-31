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
import { UNKNOWN_VIDEO_IDENTITY } from '@/utils/videoIdentity';

import type {
  AnalysisStat,
  InferredSample,
  Liveness,
  Playhead,
  CacheReadContext,
  StoredSample,
  UnreachableReason,
} from '@/utils/lookahead/ports';
import type { CachedSampleReader } from '@/utils/lookahead/sampleQuality';
import type { IPersistentVideoIdentity } from '@/utils/types';

const log = getLogger('lookaheadClient');

const MIN_PORT_LIFETIME_FOR_REOPEN_MS = 5_000;

/**
 * A frame the lookahead host decoded and wants inferred through the shared pipeline.
 */
export interface LookaheadInferenceRequest {
  pointUs: number;
  bitmap: ImageBitmap;
  originalWidth: number;
  originalHeight: number;
  priority: number;
}

/**
 * Callbacks through which a lookahead host reports to the VideoSession that opened the analysis.
 */
export interface LookaheadHandlers {
  reachable(tap: Exclude<TapKind, 'none'>): void;
  unreachable(reason: UnreachableReason): void;
  sample(sample: StoredSample): void;
  stat(stat: AnalysisStat): void;
  infer(request: LookaheadInferenceRequest): Promise<InferredSample | null>;
}

/**
 * Content-side control of one open Lookahead Analysis.
 */
export interface LookaheadSession {
  setPlayhead(playhead: Playhead): void;
  setVisible(visible: boolean): void;
  setLiveness(liveness: Liveness): void;
  updateReadContext(change: Partial<CacheReadContext>): void;
  close(): void;
}

/**
 * Transport to the lookahead host: the hidden iframe's port on Chrome, the event page's runtime port
 * on Firefox.
 */
interface HostLink {
  send(message: ContentToHost, transfer?: Transferable[]): void;
}

let hookPort: MessagePort | null = null;
let hookAcknowledged = false;
let listeningToHook = false;
let link: HostLink | null = null;

/**
 * An open analysis as the client remembers it, so it can be re-opened with its latest playhead,
 * visibility, liveness and read context after the Firefox host reconnects.
 */
interface ClientSession {
  open: OpenAnalysis;
  handlers: LookaheadHandlers;
  playhead?: Playhead;
  visible?: boolean;
  liveness?: Liveness;
}

const sessions = new Map<string, ClientSession>();

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
    void readCache(message.identity, message.reader).then(samples =>
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
        .publishVideoSamples(message.identity, open.origin, message.samples)
        .catch((error: unknown) => log.debug('lookahead.cache.publish_failed', { error }));
      break;
  }
}

async function readCache(identity: IPersistentVideoIdentity, reader: CachedSampleReader): Promise<StoredSample[]> {
  try {
    return (await backgroundRpc.getCachedVideoPredictions(identity, reader)).samples;
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

function resendSession(host: HostLink, session: ClientSession): void {
  const { sessionId } = session.open;
  host.send(session.open);
  if (session.playhead) host.send({ t: 'playhead', sessionId, playhead: session.playhead });
  if (session.visible !== undefined) host.send({ t: 'visible', sessionId, visible: session.visible });
  if (session.liveness) host.send({ t: 'liveness', sessionId, liveness: session.liveness });
}

function abandonSessions(): void {
  for (const { handlers } of sessions.values()) handlers.unreachable('hook');
  sessions.clear();
}

function reopenSessions(): void {
  try {
    const host = hostLink();
    for (const session of sessions.values()) resendSession(host, session);
  } catch (error) {
    log.debug('lookahead.port.reconnect_failed', { error });
    link = null;
    abandonSessions();
  }
}

function connectFirefoxHost(): HostLink {
  const connectedAt = performance.now();
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
    if (sessions.size === 0) return;
    if (performance.now() - connectedAt < MIN_PORT_LIFETIME_FOR_REOPEN_MS) abandonSessions();
    else reopenSessions();
  });
  hookPortOrNew().onmessage = (event: MessageEvent<HookMessage>) => post({ k: 'hook', m: event.data });
  return { send: message => post({ k: 'content', m: message }) };
}

function hostLink(): HostLink {
  link ??= IS_CHROME ? connectChromeHost() : connectFirefoxHost();
  return link;
}

/** A private tab's analysis stays in memory: an unknown identity keeps the host off the persistent cache. */
const cacheableReadContext = (readContext: CacheReadContext): CacheReadContext =>
  browser.extension.inIncognitoContext ? { ...readContext, identity: UNKNOWN_VIDEO_IDENTITY } : readContext;

export function openLookahead(analysis: OpenAnalysis, handlers: LookaheadHandlers): LookaheadSession {
  const open = { ...analysis, readContext: cacheableReadContext(analysis.readContext) };
  const session: ClientSession = { open, handlers };
  sessions.set(open.sessionId, session);
  const host = hostLink();
  host.send(open);
  return {
    setPlayhead: playhead => {
      session.playhead = playhead;
      link?.send({ t: 'playhead', sessionId: open.sessionId, playhead });
    },
    setVisible: visible => {
      session.visible = visible;
      link?.send({ t: 'visible', sessionId: open.sessionId, visible });
    },
    setLiveness: liveness => {
      session.liveness = liveness;
      link?.send({ t: 'liveness', sessionId: open.sessionId, liveness });
    },
    updateReadContext: change => {
      const readContext = cacheableReadContext({ ...session.open.readContext, ...change });
      session.open = { ...session.open, readContext };
      link?.send({ t: 'readContext', sessionId: open.sessionId, readContext });
    },
    close: () => {
      if (!sessions.delete(open.sessionId)) return;
      link?.send({ t: 'close', sessionId: open.sessionId });
    },
  };
}
