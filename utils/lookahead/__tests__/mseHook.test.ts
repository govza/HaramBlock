import { runInNewContext } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installMseHook } from '@/utils/lookahead/mseHook';
import { MSE_HOOK_HANDSHAKE, type HookCommand, type HookMessage } from '@/utils/lookahead/protocol';

const VP9_MIME = 'video/webm; codecs="vp9"';
const OPUS_MIME = 'audio/webm; codecs="opus"';

interface FakeSourceBuffer extends SourceBuffer {
  appended: ArrayBuffer[];
  failNextAppend: boolean;
  completeAppend(): void;
}

function createPage() {
  const openPorts: MessagePort[] = [];

  class FakeSourceBufferImpl extends EventTarget {
    timestampOffset = 0;
    appended: ArrayBuffer[] = [];
    failNextAppend = false;

    appendBuffer(data: BufferSource): void {
      if (this.failNextAppend) {
        this.failNextAppend = false;
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      this.appended.push(ArrayBuffer.isView(data) ? data.buffer : data);
    }

    completeAppend(): void {
      this.dispatchEvent(new Event('update'));
    }
  }

  class FakeMediaSource {
    sourceBuffers: SourceBuffer[] = [];

    addSourceBuffer(_type: string): SourceBuffer {
      const buffer = new FakeSourceBufferImpl() as unknown as SourceBuffer;
      this.sourceBuffers.push(buffer);
      return buffer;
    }

    removeSourceBuffer(buffer: SourceBuffer): void {
      this.sourceBuffers = this.sourceBuffers.filter(candidate => candidate !== buffer);
    }

    endOfStream(): void {}
  }

  let nextObjectUrl = 1;
  const target = Object.assign(new EventTarget(), {
    MediaSource: FakeMediaSource,
    SourceBuffer: FakeSourceBufferImpl,
    URL: { createObjectURL: (_object: unknown) => `blob:https://page.test/${nextObjectUrl++}` },
    document: { getElementById: () => null },
    postMessage(data: unknown, _origin: string, transfer: Transferable[] = []) {
      const event = Object.assign(new Event('message'), {
        data,
        source: target,
        ports: transfer.filter((item): item is MessagePort => item instanceof MessagePort),
      });
      target.dispatchEvent(event);
    },
  });
  installMseHook(target as unknown as Window & typeof globalThis);

  const received: HookMessage[] = [];
  const connect = () => {
    const channel = new MessageChannel();
    openPorts.push(channel.port1, channel.port2);
    const hookSide = channel.port2;
    const postSpy = vi.spyOn(hookSide, 'postMessage');
    channel.port1.onmessage = (event: MessageEvent<HookMessage>) => received.push(event.data);
    target.postMessage({ [MSE_HOOK_HANDSHAKE]: 'port' }, '*', [hookSide]);
    return { command: (command: HookCommand) => channel.port1.postMessage(command), postSpy };
  };

  const openSource = (mime = VP9_MIME) => {
    const source = new FakeMediaSource() as unknown as MediaSource;
    target.URL.createObjectURL(source);
    const buffer = source.addSourceBuffer(mime) as FakeSourceBuffer;
    return { source, buffer };
  };

  const close = () => {
    for (const port of openPorts) port.close();
  };

  return { connect, openSource, received, close };
}

let page: ReturnType<typeof createPage> | null = null;
const newPage = () => {
  page = createPage();
  return page;
};

afterEach(() => page?.close());

const appendsOf = (messages: HookMessage[]) =>
  messages.flatMap(message => (message.t === 'append' ? [[...new Uint8Array(message.bytes)]] : []));

const appendAndComplete = (buffer: FakeSourceBuffer, bytes: number[] | Uint8Array<ArrayBuffer>) => {
  buffer.appendBuffer(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  buffer.completeAppend();
};

const sourceIdOf = (messages: HookMessage[]) => messages.find(message => message.t === 'source')?.sourceId ?? -1;

const wantAnnouncedSource = async (received: HookMessage[], command: (command: HookCommand) => void) => {
  await vi.waitFor(() => expect(received.some(message => message.t === 'source')).toBe(true));
  command({ t: 'want', sourceId: sourceIdOf(received) });
  await new Promise(resolve => setTimeout(resolve, 10));
};

describe('MSE hook: streaming appends to a wanted source', () => {
  it("posts each append on its own 'update', before the page's update handler appends the next chunk", async () => {
    const { connect, openSource, received } = newPage();
    const { command } = connect();
    const { buffer } = openSource();
    await wantAnnouncedSource(received, command);

    const appendedAtEachUpdate: number[][][] = [];
    let pageAppends = 0;
    buffer.addEventListener('update', () => {
      if (pageAppends++ === 0) buffer.appendBuffer(new Uint8Array([2]));
    });
    appendAndComplete(buffer, [1]);
    await new Promise(resolve => setTimeout(resolve, 10));
    appendedAtEachUpdate.push(appendsOf(received));
    buffer.completeAppend();
    await vi.waitFor(() => expect(appendsOf(received)).toHaveLength(2));

    expect(appendedAtEachUpdate).toEqual([[[1]]]);
    expect(appendsOf(received)).toEqual([[1], [2]]);
  });

  it('transfers a private slice of the appended bytes, leaving the page buffer intact', async () => {
    const { connect, openSource, received } = newPage();
    const { command, postSpy } = connect();
    const { buffer } = openSource();
    await wantAnnouncedSource(received, command);

    const pageBytes = new Uint8Array([7, 8, 9]);
    appendAndComplete(buffer, [...pageBytes]);
    buffer.appendBuffer(pageBytes);
    buffer.completeAppend();

    const appendPost = postSpy.mock.calls.find(([message]) => (message as HookMessage).t === 'append');
    const [message, transfer] = appendPost as [Extract<HookMessage, { t: 'append' }>, Transferable[]];
    expect(transfer).toContain(message.bytes);
    expect(message.bytes.byteLength).toBe(0);
    expect(pageBytes.byteLength).toBe(3);
    await vi.waitFor(() =>
      expect(appendsOf(received)).toEqual([
        [7, 8, 9],
        [7, 8, 9],
      ]),
    );
  });

  it('recognises ArrayBuffers from another realm by their type tag', async () => {
    const { connect, openSource, received } = newPage();
    const { command } = connect();
    const { buffer } = openSource();
    await wantAnnouncedSource(received, command);

    const foreignBuffer = runInNewContext('new Uint8Array([4, 5]).buffer') as ArrayBuffer;
    const foreignView = runInNewContext('new Uint8Array([0, 6, 0]).subarray(1, 2)') as Uint8Array<ArrayBuffer>;
    expect(foreignBuffer instanceof ArrayBuffer).toBe(false);
    buffer.appendBuffer(foreignBuffer);
    buffer.completeAppend();
    buffer.appendBuffer(foreignView);
    buffer.completeAppend();

    await vi.waitFor(() => expect(appendsOf(received)).toEqual([[4, 5], [6]]));
  });

  it('never posts an append the browser rejected, and rethrows its error to the page', async () => {
    const { connect, openSource, received } = newPage();
    const { command } = connect();
    const { buffer } = openSource();
    await wantAnnouncedSource(received, command);

    buffer.failNextAppend = true;
    expect(() => buffer.appendBuffer(new Uint8Array([1]))).toThrow('Quota exceeded');
    appendAndComplete(buffer, [2]);

    await vi.waitFor(() => expect(appendsOf(received)).toEqual([[2]]));
  });

  it('never streams the bytes of an audio SourceBuffer', async () => {
    const { connect, openSource, received } = newPage();
    const { command } = connect();
    const { buffer } = openSource(OPUS_MIME);
    await wantAnnouncedSource(received, command);

    appendAndComplete(buffer, [1, 2]);
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(received.filter(message => message.t === 'buffer')).toHaveLength(1);
    expect(appendsOf(received)).toEqual([]);
  });

  it('tells every video SourceBuffer of the source that its stream ended, after its last append', async () => {
    const { connect, openSource, received } = newPage();
    const { command } = connect();
    const { source, buffer } = openSource();
    source.addSourceBuffer(OPUS_MIME);
    await wantAnnouncedSource(received, command);
    appendAndComplete(buffer, [1]);

    source.endOfStream();

    await vi.waitFor(() => expect(received.some(message => message.t === 'endOfStream')).toBe(true));
    const videoBufferId = received.find(message => message.t === 'buffer')?.bufferId;
    const streamOrder = received.flatMap(message =>
      message.t === 'append' || message.t === 'endOfStream' ? [message.t] : [],
    );
    expect(streamOrder).toEqual(['append', 'endOfStream']);
    expect(received.filter(message => message.t === 'endOfStream')).toEqual([
      { t: 'endOfStream', sourceId: sourceIdOf(received), bufferId: videoBufferId },
    ]);
  });
});

describe('MSE hook: appends made before the source is wanted', () => {
  it('replays every recorded append in order once the source is wanted, the init segment first', async () => {
    const { connect, openSource, received } = newPage();
    const { buffer } = openSource();
    appendAndComplete(buffer, [0xa]);
    appendAndComplete(buffer, [0xb]);
    const { command } = connect();
    await vi.waitFor(() => expect(received.some(message => message.t === 'source')).toBe(true));

    command({ t: 'want', sourceId: sourceIdOf(received) });

    await vi.waitFor(() => expect(appendsOf(received)).toEqual([[0xa], [0xb]]));
  });

  it('reports the source overflowed rather than replaying it with holes once the backlog outgrows its cap', async () => {
    const { connect, openSource, received } = newPage();
    const { buffer } = openSource();
    appendAndComplete(buffer, [0x1a, 0x45, 0xdf, 0xa3]);
    for (let index = 0; index < 3; index += 1) {
      appendAndComplete(buffer, new Uint8Array(20 * 1024 * 1024));
    }
    const { command } = connect();
    await vi.waitFor(() => expect(received.some(message => message.t === 'source')).toBe(true));
    const sourceId = sourceIdOf(received);

    command({ t: 'want', sourceId });

    await vi.waitFor(() => expect(received.some(message => message.t === 'overflow')).toBe(true));
    expect(received.find(message => message.t === 'overflow')).toEqual({ t: 'overflow', sourceId });
    expect(appendsOf(received)).toEqual([]);
  });

  it('keeps the newest appends of a dropped source past the cap, flagging where bytes went missing', async () => {
    const { connect, openSource, received } = newPage();
    const { command } = connect();
    const { buffer } = openSource();
    await wantAnnouncedSource(received, command);
    appendAndComplete(buffer, [0x1a, 0x45, 0xdf, 0xa3]);
    const sourceId = sourceIdOf(received);
    command({ t: 'drop', sourceId });
    await new Promise(resolve => setTimeout(resolve, 10));
    for (let index = 0; index < 3; index += 1) appendAndComplete(buffer, new Uint8Array(20 * 1024 * 1024));
    appendAndComplete(buffer, [0xe]);
    received.length = 0;

    command({ t: 'want', sourceId });

    await vi.waitFor(() => expect(appendsOf(received).at(-1)).toEqual([0xe]));
    const replayed = received.filter(message => message.t === 'append');
    expect(received.some(message => message.t === 'overflow')).toBe(false);
    expect(replayed.map(message => message.bytes.byteLength)).toEqual([20 * 1024 * 1024, 20 * 1024 * 1024, 1]);
    expect(replayed[0]).toHaveProperty('discontinuity', true);
  });
});
