import { isArrayBufferTag, MSE_HOOK_HANDSHAKE, type HookMessage, type WireChunk } from '@/utils/lookahead/protocol';

const INSTALLED = Symbol.for('haramblock.mseHook');
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;

interface HookedBuffer {
  sourceId: number;
  bufferId: number;
  pending: { bytes: ArrayBuffer; timestampOffset: number }[];
}

interface Outbox {
  send(message: HookMessage, transfer?: Transferable[]): void;
}

function createOutbox(target: Window): Outbox {
  let port: MessagePort | null = null;
  const queue: { message: HookMessage; transfer: Transferable[] }[] = [];
  let queuedBytes = 0;

  target.addEventListener('message', event => {
    if (port || event.source !== target) return;
    if ((event.data as Record<string, unknown> | null)?.[MSE_HOOK_HANDSHAKE] !== 'port') return;
    const [received] = event.ports;
    if (!received) return;
    port = received;
    for (const queued of queue.splice(0)) port.postMessage(queued.message, queued.transfer);
    queuedBytes = 0;
    target.postMessage({ [MSE_HOOK_HANDSHAKE]: 'ack' }, '*');
  });
  target.postMessage({ [MSE_HOOK_HANDSHAKE]: 'ready' }, '*');

  return {
    send(message, transfer = []) {
      if (port) {
        port.postMessage(message, transfer);
        return;
      }
      if (message.t === 'append') {
        if (queuedBytes + message.bytes.byteLength > MAX_QUEUED_BYTES) return;
        queuedBytes += message.bytes.byteLength;
      }
      queue.push({ message, transfer });
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
  isLive?: boolean;
  isPostLiveDvr?: boolean;
}

function youTubeVideoDetails(player: HTMLElement | null): YouTubeVideoDetails | undefined {
  const getPlayerResponse: unknown = player && Reflect.get(player, 'getPlayerResponse');
  if (typeof getPlayerResponse !== 'function') return undefined;
  const response: unknown = Reflect.apply(getPlayerResponse, player, []);
  const details: unknown = response && typeof response === 'object' ? Reflect.get(response, 'videoDetails') : null;
  return details && typeof details === 'object' ? details : undefined;
}

function isYouTubeLive(target: Window): boolean {
  try {
    const details = youTubeVideoDetails(target.document.getElementById('movie_player'));
    return Boolean(details?.isLive || details?.isPostLiveDvr);
  } catch {
    return false;
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

  const originalCreateObjectURL = target.URL.createObjectURL.bind(target.URL);
  target.URL.createObjectURL = function createObjectURL(object: Blob | MediaSource): string {
    const objectUrl = originalCreateObjectURL(object);
    guard(() => {
      if (object instanceof MediaSourceCtor) {
        outbox.send({ t: 'source', sourceId: sourceIdOf(object), objectUrl, live: isYouTubeLive(target) });
      }
    });
    return objectUrl;
  };

  const sourceProto = MediaSourceCtor.prototype;
  const originalAddSourceBuffer = originalMethod<MediaSource['addSourceBuffer']>(sourceProto, 'addSourceBuffer');
  sourceProto.addSourceBuffer = function addSourceBuffer(this: MediaSource, type: string): SourceBuffer {
    const buffer = originalAddSourceBuffer.call(this, type);
    guard(() => {
      const hooked: HookedBuffer = { sourceId: sourceIdOf(this), bufferId: nextId++, pending: [] };
      buffers.set(buffer, hooked);
      const mime = typeof type === 'string' ? type : '';
      outbox.send({ t: 'buffer', sourceId: hooked.sourceId, bufferId: hooked.bufferId, mime });
      buffer.addEventListener('update', () =>
        guard(() => {
          for (const append of hooked.pending.splice(0)) {
            outbox.send({ t: 'append', sourceId: hooked.sourceId, bufferId: hooked.bufferId, ...append }, [
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
      if (hooked) outbox.send({ t: 'removeBuffer', sourceId: hooked.sourceId, bufferId: hooked.bufferId });
    });
  };

  const bufferProto = SourceBufferCtor.prototype;
  const originalAppendBuffer = originalMethod<SourceBuffer['appendBuffer']>(bufferProto, 'appendBuffer');
  bufferProto.appendBuffer = function appendBuffer(this: SourceBuffer, data: BufferSource): void {
    let pending: { bytes: ArrayBuffer; timestampOffset: number } | null = null;
    guard(() => {
      const hooked = buffers.get(this);
      const bytes = hooked ? sliceOf(data) : null;
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
        if (hooked) outbox.send({ t: 'changeType', sourceId: hooked.sourceId, bufferId: hooked.bufferId, mime: type });
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
        outbox.send(
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
