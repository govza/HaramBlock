import {
  isArrayBufferTag,
  MSE_HOOK_HANDSHAKE,
  type HookCommand,
  type HookMessage,
  type WireChunk,
} from '@/utils/lookahead/protocol';

import type { Liveness } from '@/utils/lookahead/ports';

const INSTALLED = Symbol.for('haramblock.mseHook');
const MAX_RECORDED_BYTES_PER_SOURCE = 48 * 1024 * 1024;

interface HookedBuffer {
  sourceId: number;
  bufferId: number;
  audio: boolean;
  pending: { bytes: ArrayBuffer; timestampOffset: number }[];
}

type AnnouncedMessage = Extract<HookMessage, { t: 'source' | 'liveness' }>;
type StreamedMessage = Exclude<HookMessage, { t: 'source' | 'liveness' | 'overflow' }>;

interface Outbox {
  announce(message: AnnouncedMessage): void;
  stream(message: StreamedMessage, transfer?: Transferable[]): void;
}

interface Recorded {
  message: StreamedMessage;
  transfer: Transferable[];
}

interface SourceStream {
  wanted: boolean;
  resumable: boolean;
  overflowed: boolean;
  recorded: Recorded[];
  recordedBytes: number;
  resyncBuffers: Set<number>;
}

const byteSizeOf = (message: HookMessage): number => {
  if (message.t === 'append') return message.bytes.byteLength;
  if (message.t === 'chunks') return message.chunks.reduce((total, chunk) => total + chunk.data.byteLength, 0);
  return 0;
};

const isAudioMime = (mime: string): boolean => mime.trim().toLowerCase().startsWith('audio/');

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
        overflowed: false,
        recorded: [],
        recordedBytes: 0,
        resyncBuffers: new Set(),
      };
      streams.set(sourceId, stream);
    }
    return stream;
  };

  const flagResync = (stream: SourceStream, message: StreamedMessage) => {
    if (message.t !== 'append' || !stream.resyncBuffers.delete(message.bufferId)) return;
    message.discontinuity = true;
  };

  const evictOldestAppends = (stream: SourceStream) => {
    while (stream.recordedBytes > MAX_RECORDED_BYTES_PER_SOURCE) {
      const oldest = stream.recorded.findIndex(recorded => byteSizeOf(recorded.message) > 0);
      if (oldest < 0) return;
      const [evicted] = stream.recorded.splice(oldest, 1);
      if (!evicted) return;
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

  const replay = (sourceId: number, stream: SourceStream, to: MessagePort) => {
    if (stream.overflowed) {
      stream.wanted = false;
      to.postMessage({ t: 'overflow', sourceId } satisfies HookMessage);
      return;
    }
    stream.resumable = true;
    for (const recorded of stream.recorded.splice(0)) to.postMessage(recorded.message, recorded.transfer);
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
      stream.resumable = false;
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

interface YouTubeVideoDetails {
  videoId?: string;
  isLive?: boolean;
  isPostLiveDvr?: boolean;
}

const YOUTUBE_HOST = /(^|\.)youtube(-nocookie)?\.com$/;
const YOUTUBE_PATH_VIDEO_ID = /^\/(?:shorts|live|embed)\/([\w-]+)/;

function callPlayer(player: HTMLElement, name: string): unknown {
  const method: unknown = Reflect.get(player, name);
  return typeof method === 'function' ? Reflect.apply(method, player, []) : undefined;
}

function objectOrUndefined(value: unknown): object | undefined {
  return value && typeof value === 'object' ? value : undefined;
}

function videoIdInUrl(href: string): string | undefined {
  try {
    const url = new URL(href);
    return url.searchParams.get('v') ?? YOUTUBE_PATH_VIDEO_ID.exec(url.pathname)?.[1];
  } catch {
    return undefined;
  }
}

function currentYouTubeVideoId(player: HTMLElement, target: Window): string | undefined {
  const playing: unknown = Reflect.get(objectOrUndefined(callPlayer(player, 'getVideoData')) ?? {}, 'video_id');
  if (typeof playing === 'string' && playing) return playing;
  return videoIdInUrl(target.location.href);
}

function youTubeLiveness(target: Window): Liveness {
  try {
    const player = target.document.getElementById('movie_player');
    if (!player || typeof Reflect.get(player, 'getPlayerResponse') !== 'function') {
      return YOUTUBE_HOST.test(target.location.hostname) ? 'unknown' : 'vod';
    }
    const response = objectOrUndefined(callPlayer(player, 'getPlayerResponse'));
    const details: YouTubeVideoDetails | undefined = objectOrUndefined(
      response && Reflect.get(response, 'videoDetails'),
    );
    if (!details) return 'unknown';
    const currentVideoId = currentYouTubeVideoId(player, target);
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

  const originalCreateObjectURL = target.URL.createObjectURL.bind(target.URL);
  target.URL.createObjectURL = function createObjectURL(object: Blob | MediaSource): string {
    const objectUrl = originalCreateObjectURL(object);
    guard(() => {
      if (object instanceof MediaSourceCtor) {
        const sourceId = sourceIdOf(object);
        const liveness = youTubeLiveness(target);
        if (liveness === 'unknown') unresolvedLiveness.add(sourceId);
        outbox.announce({ t: 'source', sourceId, objectUrl, liveness });
      }
    });
    return objectUrl;
  };

  const sourceProto = MediaSourceCtor.prototype;
  const originalAddSourceBuffer = originalMethod<MediaSource['addSourceBuffer']>(sourceProto, 'addSourceBuffer');
  sourceProto.addSourceBuffer = function addSourceBuffer(this: MediaSource, type: string): SourceBuffer {
    const buffer = originalAddSourceBuffer.call(this, type);
    guard(() => {
      const mime = typeof type === 'string' ? type : '';
      const hooked: HookedBuffer = {
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
