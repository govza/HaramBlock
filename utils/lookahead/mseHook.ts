import { initPieceKindOf, initSegmentLength, type InitPieceKind } from '@/utils/lookahead/containerSniff';
import {
  HOOK_IDENTITY_ATTR,
  isArrayBufferTag,
  MSE_HOOK_HANDSHAKE,
  type HookCommand,
  type HookIdentityClaim,
  type HookMessage,
  type WireChunk,
} from '@/utils/lookahead/protocol';
import {
  playingVideoId,
  videoDetailsOf,
  YOUTUBE_HOST,
  YOUTUBE_PLAYER_SELECTOR,
  youTubeVideoIdentity,
} from '@/utils/lookahead/youTubePlayer';

import type { Liveness } from '@/utils/lookahead/ports';

const INSTALLED = Symbol.for('haramblock.mseHook');
const MAX_RECORDED_BYTES_PER_SOURCE = 48 * 1024 * 1024;

/**
 * Hook-side bookkeeping for one page SourceBuffer, holding copied appends until the browser confirms them on `update`.
 */
interface HookedBuffer {
  mediaSource: MediaSource;
  sourceId: number;
  bufferId: number;
  audio: boolean;
  pending: { bytes: ArrayBuffer; timestampOffset: number }[];
}

type AnnouncedMessage = Extract<HookMessage, { t: 'source' | 'liveness' }>;
type StreamedMessage = Exclude<HookMessage, { t: 'source' | 'liveness' | 'overflow' }>;

/**
 * The hook's sending side: announcements go to every port, streamed messages only to a source the host wants (otherwise
 * recorded).
 */
interface Outbox {
  announce(message: AnnouncedMessage): void;
  stream(message: StreamedMessage, transfer?: Transferable[]): void;
}

/**
 * A streamed message held for a source nobody wants yet, replayed in order on the next `want`.
 */
interface Recorded {
  message: StreamedMessage;
  transfer: Transferable[];
  pinned?: boolean;
}

/**
 * Init-segment bytes kept for a buffer so a replacement port's host can decode it without the original appends.
 */
interface InitPiece {
  bytes: ArrayBuffer;
  timestampOffset: number;
}

/**
 * What a new host needs to resume a buffer it never saw created: its `buffer` message and latest init segment.
 */
interface BufferPreamble {
  bufferMessage: Extract<HookMessage, { t: 'buffer' }>;
  init: InitPiece[];
}

/**
 * Per-source pull state of the hook: whether it is wanted, its recorded backlog, and which buffers need a resync or
 * re-introduction.
 */
interface SourceStream {
  wanted: boolean;
  resumable: boolean;
  reintroduce: boolean;
  overflowed: boolean;
  recorded: Recorded[];
  recordedBytes: number;
  resyncBuffers: Set<number>;
  preambles: Map<number, BufferPreamble>;
}

const byteSizeOf = (message: HookMessage): number => {
  if (message.t === 'append') return message.bytes.byteLength;
  if (message.t === 'chunks') return message.chunks.reduce((total, chunk) => total + chunk.data.byteLength, 0);
  return 0;
};

const isAudioMime = (mime: string): boolean => mime.trim().toLowerCase().startsWith('audio/');

const initBytesOf = (bytes: ArrayBuffer, kind: InitPieceKind): ArrayBuffer =>
  bytes.slice(0, initSegmentLength(bytes, kind));

const isLoneFtyp = (init: InitPiece[]): boolean =>
  init.length === 1 && init[0] !== undefined && initPieceKindOf(init[0].bytes) === 'ftyp';

const trackInitPiece = (preamble: BufferPreamble, append: Extract<StreamedMessage, { t: 'append' }>) => {
  const kind = initPieceKindOf(append.bytes);
  if (!kind) return;
  const piece = { bytes: initBytesOf(append.bytes, kind), timestampOffset: append.timestampOffset };
  preamble.init = kind === 'moov' && isLoneFtyp(preamble.init) ? [...preamble.init, piece] : [piece];
};

const trackBufferPreamble = (preambles: Map<number, BufferPreamble>, message: StreamedMessage) => {
  switch (message.t) {
    case 'buffer':
      preambles.set(message.bufferId, { bufferMessage: { ...message }, init: [] });
      break;
    case 'changeType': {
      const preamble = preambles.get(message.bufferId);
      if (preamble) {
        preambles.set(message.bufferId, { bufferMessage: { ...preamble.bufferMessage, mime: message.mime }, init: [] });
      }
      break;
    }
    case 'append': {
      const preamble = preambles.get(message.bufferId);
      if (preamble) trackInitPiece(preamble, message);
      break;
    }
    case 'removeBuffer':
      preambles.delete(message.bufferId);
      break;
  }
};

function createOutbox(target: Window): Outbox {
  let port: MessagePort | null = null;
  const announcements: AnnouncedMessage[] = [];
  const streams = new Map<number, SourceStream>();

  const streamOf = (sourceId: number): SourceStream => {
    let stream = streams.get(sourceId);
    if (!stream) {
      stream = {
        wanted: false,
        resumable: false,
        reintroduce: false,
        overflowed: false,
        recorded: [],
        recordedBytes: 0,
        resyncBuffers: new Set(),
        preambles: new Map(),
      };
      streams.set(sourceId, stream);
    }
    return stream;
  };

  const flagResync = (stream: SourceStream, message: StreamedMessage) => {
    if (message.t !== 'append' || !stream.resyncBuffers.delete(message.bufferId)) return;
    message.discontinuity = true;
  };

  const initOnlyReplacement = (evicted: Recorded): Recorded[] => {
    if (evicted.message.t !== 'append') return [];
    const kind = initPieceKindOf(evicted.message.bytes);
    if (!kind) return [];
    const bytes = initBytesOf(evicted.message.bytes, kind);
    return [{ message: { ...evicted.message, bytes }, transfer: [bytes], pinned: true }];
  };

  const evictOldestAppends = (stream: SourceStream) => {
    while (stream.recordedBytes > MAX_RECORDED_BYTES_PER_SOURCE) {
      const oldest = stream.recorded.findIndex(recorded => !recorded.pinned && byteSizeOf(recorded.message) > 0);
      if (oldest < 0) return;
      const [evicted] = stream.recorded.splice(oldest, 1);
      if (!evicted) return;
      const replacement = initOnlyReplacement(evicted);
      stream.recorded.splice(oldest, 0, ...replacement);
      stream.recordedBytes += replacement.reduce((total, kept) => total + byteSizeOf(kept.message), 0);
      stream.recordedBytes -= byteSizeOf(evicted.message);
      stream.resyncBuffers.add(evicted.message.bufferId);
      const successor = stream.recorded
        .slice(oldest)
        .find(recorded => recorded.message.t === 'append' && recorded.message.bufferId === evicted.message.bufferId);
      if (successor) flagResync(stream, successor.message);
    }
  };

  const overflow = (stream: SourceStream) => {
    stream.overflowed = true;
    stream.recorded = [];
    stream.recordedBytes = 0;
  };

  const record = (stream: SourceStream, entry: Recorded) => {
    if (stream.overflowed) return;
    flagResync(stream, entry.message);
    stream.recorded.push(entry);
    stream.recordedBytes += byteSizeOf(entry.message);
    if (stream.recordedBytes <= MAX_RECORDED_BYTES_PER_SOURCE) return;
    if (stream.resumable) evictOldestAppends(stream);
    else overflow(stream);
  };

  const reintroduceBuffers = (sourceId: number, stream: SourceStream, to: MessagePort) => {
    const recordedBuffers = new Set(
      stream.recorded.flatMap(({ message }) => (message.t === 'buffer' ? [message.bufferId] : [])),
    );
    for (const [bufferId, { bufferMessage, init }] of stream.preambles) {
      if (recordedBuffers.has(bufferId)) continue;
      to.postMessage(bufferMessage);
      for (const piece of init) to.postMessage({ t: 'append', sourceId, bufferId, ...piece } satisfies HookMessage);
      stream.resyncBuffers.add(bufferId);
    }
  };

  const replay = (sourceId: number, stream: SourceStream, to: MessagePort) => {
    if (stream.overflowed) {
      stream.wanted = false;
      to.postMessage({ t: 'overflow', sourceId } satisfies HookMessage);
      return;
    }
    if (stream.reintroduce) reintroduceBuffers(sourceId, stream, to);
    stream.reintroduce = false;
    stream.resumable = true;
    for (const recorded of stream.recorded.splice(0)) {
      flagResync(stream, recorded.message);
      to.postMessage(recorded.message, recorded.transfer);
    }
    stream.recordedBytes = 0;
  };

  const onCommand = (command: HookCommand) => {
    const stream = streamOf(command.sourceId);
    stream.wanted = command.t === 'want';
    if (stream.wanted && port) replay(command.sourceId, stream, port);
  };

  target.addEventListener('message', event => {
    if (event.source !== target) return;
    if ((event.data as Record<string, unknown> | null)?.[MSE_HOOK_HANDSHAKE] !== 'port') return;
    const [received] = event.ports;
    if (!received) return;
    port?.close();
    port = received;
    for (const stream of streams.values()) {
      stream.wanted = false;
      stream.reintroduce = true;
    }
    port.onmessage = (commandEvent: MessageEvent<HookCommand>) => guard(() => onCommand(commandEvent.data));
    for (const announcement of announcements) port.postMessage(announcement);
    target.postMessage({ [MSE_HOOK_HANDSHAKE]: 'ack' }, '*');
  });
  target.postMessage({ [MSE_HOOK_HANDSHAKE]: 'ready' }, '*');

  return {
    announce(message) {
      announcements.push(message);
      port?.postMessage(message);
    },
    stream(message, transfer = []) {
      const stream = streamOf(message.sourceId);
      trackBufferPreamble(stream.preambles, message);
      if (stream.wanted && port) {
        flagResync(stream, message);
        port.postMessage(message, transfer);
        return;
      }
      record(stream, { message, transfer });
    },
  };
}

function sliceOf(data: unknown): ArrayBuffer | null {
  if (isArrayBufferTag(data)) return data.slice(0);
  if (ArrayBuffer.isView(data) && isArrayBufferTag(data.buffer)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  return null;
}

function youTubeLiveness(target: Window): Liveness {
  try {
    const player = target.document.getElementById('movie_player');
    if (!player || typeof Reflect.get(player, 'getPlayerResponse') !== 'function') {
      return YOUTUBE_HOST.test(target.location.hostname) ? 'unknown' : 'vod';
    }
    const details = videoDetailsOf(player);
    if (!details) return 'unknown';
    const currentVideoId = playingVideoId(player, target.location.href);
    if (currentVideoId && details.videoId !== currentVideoId) return 'unknown';
    return details.isLive || details.isPostLiveDvr ? 'live' : 'vod';
  } catch {
    return 'vod';
  }
}

function originalMethod<T>(prototype: object, name: string): T {
  return Object.getOwnPropertyDescriptor(prototype, name)?.value as T;
}

function toWireChunk(chunk: EncodedVideoChunk): WireChunk {
  const data = new ArrayBuffer(chunk.byteLength);
  chunk.copyTo(data);
  return { type: chunk.type, timestampUs: chunk.timestamp, durationUs: chunk.duration ?? 0, data };
}

function guard(action: () => void): void {
  try {
    action();
  } catch {
    return;
  }
}

function runAfterSetter<T>(prototype: object, name: string, after: (self: T, value: unknown) => void): void {
  const property = Object.getOwnPropertyDescriptor(prototype, name);
  if (!property?.set) return;
  Object.defineProperty(prototype, name, {
    ...property,
    set(this: T, value: unknown) {
      property.set?.call(this, value);
      guard(() => after(this, value));
    },
  });
}

/**
 * The `<video>` a hooked `MediaSource` was assigned to, and whether its identity is settled for good.
 */
interface IdentityBinding {
  video: HTMLMediaElement;
  objectUrl: string;
  settled: boolean;
}

/**
 * Binds each `MediaSource` to the `<video>` its blob URL is assigned to and publishes the source's video identity on
 * that element: re-evaluated as its duration is set and on each append, until an append finds it stable.
 */
interface IdentityBinder {
  register(objectUrl: string, source: MediaSource): void;
  durationSet(source: MediaSource): void;
  appending(source: MediaSource): void;
}

function createIdentityBinder(target: Window & typeof globalThis): IdentityBinder {
  const sourcesByUrl = new Map<string, WeakRef<MediaSource>>();
  const bindings = new WeakMap<MediaSource, IdentityBinding>();
  const adPlayers = new WeakSet<Element>();
  const watchedPlayers = new WeakSet<Element>();
  const MediaElementCtor = target.HTMLMediaElement as typeof HTMLMediaElement | undefined;
  const mediaProto = MediaElementCtor?.prototype;
  const originalSetAttribute = mediaProto && Reflect.get(mediaProto, 'setAttribute');
  const onYouTube = () => YOUTUBE_HOST.test(target.location.hostname);

  const watchAds = (player: Element) => {
    if (watchedPlayers.has(player)) return;
    watchedPlayers.add(player);
    const subscribe: unknown = Reflect.get(player, 'addEventListener');
    if (typeof subscribe !== 'function') return;
    Reflect.apply(subscribe, player, ['onAdStart', () => adPlayers.add(player)]);
    Reflect.apply(subscribe, player, ['onAdFinish', () => adPlayers.delete(player)]);
  };

  const evaluate = (source: MediaSource, settleIfStable: boolean) => {
    const binding = bindings.get(source);
    if (!binding || binding.settled || binding.video.src !== binding.objectUrl || !originalSetAttribute) return;
    const player = binding.video.closest(YOUTUBE_PLAYER_SELECTOR);
    if (!player) return;
    watchAds(player);
    const identity = youTubeVideoIdentity(player, source.duration, adPlayers.has(player), target.location.href);
    binding.settled = settleIfStable && identity.kind === 'stable';
    const claim: HookIdentityClaim = { objectUrl: binding.objectUrl, identity };
    originalSetAttribute.call(binding.video, HOOK_IDENTITY_ATTR, JSON.stringify(claim));
  };

  const bind = (video: HTMLMediaElement, objectUrl: unknown) => {
    if (typeof objectUrl !== 'string' || !onYouTube()) return;
    const source = sourcesByUrl.get(objectUrl)?.deref();
    if (!source) return;
    bindings.set(source, { video, objectUrl, settled: false });
    evaluate(source, false);
  };

  if (mediaProto) runAfterSetter<HTMLMediaElement>(mediaProto, 'src', bind);
  if (mediaProto && originalSetAttribute) {
    mediaProto.setAttribute = function setAttribute(this: HTMLMediaElement, name: string, value: string): void {
      originalSetAttribute.call(this, name, value);
      guard(() => {
        if (String(name).toLowerCase() === 'src') bind(this, value);
      });
    };
  }

  return {
    register: (objectUrl, source) => {
      for (const [url, reference] of sourcesByUrl) if (!reference.deref()) sourcesByUrl.delete(url);
      sourcesByUrl.set(objectUrl, new WeakRef(source));
    },
    durationSet: source => evaluate(source, false),
    appending: source => evaluate(source, true),
  };
}

export function installMseHook(target: Window & typeof globalThis): void {
  const MediaSourceCtor = target.MediaSource as typeof MediaSource | undefined;
  const SourceBufferCtor = target.SourceBuffer as typeof SourceBuffer | undefined;
  const registry = target as unknown as Record<symbol, boolean>;
  if (!MediaSourceCtor || !SourceBufferCtor || registry[INSTALLED]) return;
  registry[INSTALLED] = true;

  const outbox = createOutbox(target);
  const sourceIds = new WeakMap<MediaSource, number>();
  const unresolvedLiveness = new Set<number>();
  const buffers = new WeakMap<SourceBuffer, HookedBuffer>();
  let nextId = 1;

  const sourceIdOf = (source: MediaSource): number => {
    let id = sourceIds.get(source);
    if (id === undefined) {
      id = nextId++;
      sourceIds.set(source, id);
    }
    return id;
  };

  const resolveLiveness = (sourceId: number) => {
    if (!unresolvedLiveness.has(sourceId)) return;
    const liveness = youTubeLiveness(target);
    if (liveness === 'unknown') return;
    unresolvedLiveness.delete(sourceId);
    outbox.announce({ t: 'liveness', sourceId, liveness });
  };

  const identities = createIdentityBinder(target);

  const originalCreateObjectURL = target.URL.createObjectURL.bind(target.URL);
  target.URL.createObjectURL = function createObjectURL(object: Blob | MediaSource): string {
    const objectUrl = originalCreateObjectURL(object);
    guard(() => {
      if (object instanceof MediaSourceCtor) {
        identities.register(objectUrl, object);
        const sourceId = sourceIdOf(object);
        const liveness = youTubeLiveness(target);
        if (liveness === 'unknown') unresolvedLiveness.add(sourceId);
        outbox.announce({ t: 'source', sourceId, objectUrl, liveness });
      }
    });
    return objectUrl;
  };

  const sourceProto = MediaSourceCtor.prototype;
  runAfterSetter<MediaSource>(sourceProto, 'duration', source => identities.durationSet(source));
  const originalAddSourceBuffer = originalMethod<MediaSource['addSourceBuffer']>(sourceProto, 'addSourceBuffer');
  sourceProto.addSourceBuffer = function addSourceBuffer(this: MediaSource, type: string): SourceBuffer {
    const buffer = originalAddSourceBuffer.call(this, type);
    guard(() => {
      const mime = typeof type === 'string' ? type : '';
      const hooked: HookedBuffer = {
        mediaSource: this,
        sourceId: sourceIdOf(this),
        bufferId: nextId++,
        audio: isAudioMime(mime),
        pending: [],
      };
      buffers.set(buffer, hooked);
      outbox.stream({ t: 'buffer', sourceId: hooked.sourceId, bufferId: hooked.bufferId, mime });
      buffer.addEventListener('update', () =>
        guard(() => {
          for (const append of hooked.pending.splice(0)) {
            outbox.stream({ t: 'append', sourceId: hooked.sourceId, bufferId: hooked.bufferId, ...append }, [
              append.bytes,
            ]);
          }
        }),
      );
      const dropPending = () => {
        hooked.pending = [];
      };
      buffer.addEventListener('abort', dropPending);
      buffer.addEventListener('error', dropPending);
    });
    return buffer;
  };

  const originalRemoveSourceBuffer = originalMethod<MediaSource['removeSourceBuffer']>(
    sourceProto,
    'removeSourceBuffer',
  );
  sourceProto.removeSourceBuffer = function removeSourceBuffer(this: MediaSource, buffer: SourceBuffer): void {
    originalRemoveSourceBuffer.call(this, buffer);
    guard(() => {
      const hooked = buffers.get(buffer);
      if (hooked) outbox.stream({ t: 'removeBuffer', sourceId: hooked.sourceId, bufferId: hooked.bufferId });
    });
  };

  const originalEndOfStream = originalMethod<MediaSource['endOfStream']>(sourceProto, 'endOfStream');
  sourceProto.endOfStream = function endOfStream(this: MediaSource, error?: EndOfStreamError): void {
    originalEndOfStream.call(this, error);
    guard(() => {
      for (const buffer of Array.from(this.sourceBuffers)) {
        const hooked = buffers.get(buffer);
        if (hooked && !hooked.audio) {
          outbox.stream({ t: 'endOfStream', sourceId: hooked.sourceId, bufferId: hooked.bufferId });
        }
      }
    });
  };

  const bufferProto = SourceBufferCtor.prototype;
  const originalAppendBuffer = originalMethod<SourceBuffer['appendBuffer']>(bufferProto, 'appendBuffer');
  bufferProto.appendBuffer = function appendBuffer(this: SourceBuffer, data: BufferSource): void {
    let pending: { bytes: ArrayBuffer; timestampOffset: number } | null = null;
    guard(() => {
      const hooked = buffers.get(this);
      if (hooked) resolveLiveness(hooked.sourceId);
      if (hooked) identities.appending(hooked.mediaSource);
      const bytes = hooked && !hooked.audio ? sliceOf(data) : null;
      if (hooked && bytes) {
        pending = { bytes, timestampOffset: this.timestampOffset };
        hooked.pending.push(pending);
      }
    });
    try {
      originalAppendBuffer.call(this, data);
    } catch (error) {
      const failed = pending;
      guard(() => {
        const hooked = buffers.get(this);
        if (hooked && failed) hooked.pending = hooked.pending.filter(entry => entry !== failed);
      });
      throw error;
    }
  };

  const originalChangeType = originalMethod<SourceBuffer['changeType'] | undefined>(bufferProto, 'changeType');
  if (originalChangeType) {
    bufferProto.changeType = function changeType(this: SourceBuffer, type: string): void {
      originalChangeType.call(this, type);
      guard(() => {
        const hooked = buffers.get(this);
        if (!hooked) return;
        hooked.audio = isAudioMime(type);
        outbox.stream({ t: 'changeType', sourceId: hooked.sourceId, bufferId: hooked.bufferId, mime: type });
      });
    };
  }

  type ChunkAppender = (chunks: EncodedVideoChunk | EncodedVideoChunk[]) => Promise<void>;
  const encodedProto = bufferProto as unknown as { appendEncodedChunks?: ChunkAppender };
  const originalAppendEncodedChunks = originalMethod<ChunkAppender | undefined>(encodedProto, 'appendEncodedChunks');
  if (originalAppendEncodedChunks) {
    encodedProto.appendEncodedChunks = function appendEncodedChunks(this: SourceBuffer, chunks) {
      guard(() => {
        const hooked = buffers.get(this);
        const config = (this as unknown as { hbVideoConfig?: VideoDecoderConfig }).hbVideoConfig;
        if (!hooked || !config) return;
        const list = (Array.isArray(chunks) ? chunks : [chunks]).filter(
          chunk => typeof EncodedVideoChunk === 'function' && chunk instanceof EncodedVideoChunk,
        );
        const wire = list.map(toWireChunk);
        outbox.stream(
          { t: 'chunks', sourceId: hooked.sourceId, bufferId: hooked.bufferId, config, chunks: wire },
          wire.map(chunk => chunk.data),
        );
      });
      return originalAppendEncodedChunks.call(this, chunks);
    };
    const addWithConfig = originalMethod<MediaSource['addSourceBuffer']>(sourceProto, 'addSourceBuffer');
    sourceProto.addSourceBuffer = function addSourceBuffer(this: MediaSource, type: string): SourceBuffer {
      const buffer = addWithConfig.call(this, type);
      guard(() => {
        const config = (type as unknown as { videoConfig?: VideoDecoderConfig } | null)?.videoConfig;
        if (config) (buffer as unknown as { hbVideoConfig?: VideoDecoderConfig }).hbVideoConfig = config;
      });
      return buffer;
    };
  }
}
