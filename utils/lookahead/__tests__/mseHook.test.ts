import { runInNewContext } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installMseHook } from '@/utils/lookahead/mseHook';
import { HOOK_IDENTITY_ATTR, MSE_HOOK_HANDSHAKE, type HookCommand, type HookMessage } from '@/utils/lookahead/protocol';

const VP9_MIME = 'video/webm; codecs="vp9"';
const OPUS_MIME = 'audio/webm; codecs="opus"';

interface FakeSourceBuffer extends SourceBuffer {
  appended: ArrayBuffer[];
  failNextAppend: boolean;
  completeAppend(): void;
}

interface FakePage {
  player?: object;
  href?: string;
}

function createPage(page: FakePage = {}) {
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

    changeType(_type: string): void {}
  }

  class FakeMediaSource {
    sourceBuffers: SourceBuffer[] = [];
    private storedDuration = Number.NaN;

    get duration(): number {
      return this.storedDuration;
    }

    set duration(value: number) {
      this.storedDuration = value;
    }

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

  class FakeVideo {
    readonly attributes = new Map<string, string>();
    private assignedSrc = '';

    constructor(private readonly owner: object | null) {}

    get src(): string {
      return this.assignedSrc;
    }

    set src(value: string) {
      this.assignedSrc = value;
    }

    setAttribute(name: string, value: string): void {
      this.attributes.set(name, value);
      if (name === 'src') this.assignedSrc = value;
    }

    getAttribute(name: string): string | null {
      return this.attributes.get(name) ?? null;
    }

    closest(selector: string): object | null {
      return selector === '.html5-video-player' ? this.owner : null;
    }
  }

  let nextObjectUrl = 1;
  const target = Object.assign(new EventTarget(), {
    MediaSource: FakeMediaSource,
    SourceBuffer: FakeSourceBufferImpl,
    HTMLMediaElement: FakeVideo,
    URL: { createObjectURL: (_object: unknown) => `blob:https://page.test/${nextObjectUrl++}` },
    document: { getElementById: (id: string) => (id === 'movie_player' ? (page.player ?? null) : null) },
    location: new URL(page.href ?? 'https://page.test/'),
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

  const playSource = (owner: object | null, assign: 'property' | 'attribute' = 'property') => {
    const source = new FakeMediaSource() as unknown as MediaSource;
    const objectUrl = target.URL.createObjectURL(source);
    const buffer = source.addSourceBuffer(VP9_MIME) as FakeSourceBuffer;
    const video = new FakeVideo(owner);
    if (assign === 'property') video.src = objectUrl;
    else video.setAttribute('src', objectUrl);
    return { source, buffer, video, objectUrl };
  };

  const close = () => {
    for (const port of openPorts) port.close();
  };

  return { connect, openSource, playSource, received, close };
}

let page: ReturnType<typeof createPage> | null = null;
const newPage = (fake: FakePage = {}) => {
  page?.close();
  page = createPage(fake);
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

  it('keeps the init bytes of an evicted append that carried them', async () => {
    const WEBM_INIT = [0x1a, 0x45, 0xdf, 0xa3, 0x01];
    const { connect, openSource, received } = newPage();
    const { command } = connect();
    const { buffer } = openSource();
    await wantAnnouncedSource(received, command);
    const sourceId = sourceIdOf(received);
    command({ t: 'drop', sourceId });
    await new Promise(resolve => setTimeout(resolve, 10));
    const initAndCluster = new Uint8Array(20 * 1024 * 1024);
    initAndCluster.set([...WEBM_INIT, 0x1f, 0x43, 0xb6, 0x75]);
    appendAndComplete(buffer, initAndCluster);
    for (let index = 0; index < 3; index += 1) appendAndComplete(buffer, new Uint8Array(20 * 1024 * 1024));
    received.length = 0;

    command({ t: 'want', sourceId });

    await vi.waitFor(() => expect(received.filter(message => message.t === 'append')).toHaveLength(3));
    expect(appendsOf(received)[0]).toEqual(WEBM_INIT);
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

describe('MSE hook: a replacement port', () => {
  const WEBM_INIT = [0x1a, 0x45, 0xdf, 0xa3, 0x01];
  const MP4_INIT = [0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70];

  it('gives the new port the buffer and its latest init segment before resuming its appends', async () => {
    const { connect, openSource, received } = newPage();
    const first = connect();
    const { buffer } = openSource();
    await wantAnnouncedSource(received, first.command);
    appendAndComplete(buffer, WEBM_INIT);
    appendAndComplete(buffer, [0x1f, 0x43, 0xb6, 0x75]);
    const sourceId = sourceIdOf(received);
    const second = connect();
    await new Promise(resolve => setTimeout(resolve, 10));
    received.length = 0;

    second.command({ t: 'want', sourceId });
    await new Promise(resolve => setTimeout(resolve, 10));
    appendAndComplete(buffer, [0xc]);

    await vi.waitFor(() => expect(appendsOf(received)).toEqual([WEBM_INIT, [0xc]]));
    expect(received.find(message => message.t === 'buffer')).toMatchObject({ sourceId, mime: VP9_MIME });
    const appends = received.filter(message => message.t === 'append');
    expect(appends[0]).not.toHaveProperty('discontinuity');
    expect(appends[1]).toHaveProperty('discontinuity', true);
  });

  it('flags the first append recorded before the new port wanted the source, right after the init', async () => {
    const { connect, openSource, received } = newPage();
    const first = connect();
    const { buffer } = openSource();
    await wantAnnouncedSource(received, first.command);
    appendAndComplete(buffer, WEBM_INIT);
    const sourceId = sourceIdOf(received);
    const second = connect();
    await new Promise(resolve => setTimeout(resolve, 10));
    appendAndComplete(buffer, [0xc]);
    appendAndComplete(buffer, [0xd]);
    received.length = 0;

    second.command({ t: 'want', sourceId });

    await vi.waitFor(() => expect(appendsOf(received)).toEqual([WEBM_INIT, [0xc], [0xd]]));
    const appends = received.filter(message => message.t === 'append');
    expect(appends.map(message => message.discontinuity === true)).toEqual([false, true, false]);
  });

  it('gives the new port an fMP4 init appended as separate ftyp and moov boxes whole', async () => {
    const FTYP = [0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70];
    const MOOV = [0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x76];
    const { connect, openSource, received } = newPage();
    const first = connect();
    const { buffer } = openSource('video/mp4; codecs="avc1.64001f"');
    await wantAnnouncedSource(received, first.command);
    appendAndComplete(buffer, FTYP);
    appendAndComplete(buffer, MOOV);
    const sourceId = sourceIdOf(received);
    const second = connect();
    await new Promise(resolve => setTimeout(resolve, 10));
    received.length = 0;

    second.command({ t: 'want', sourceId });

    await vi.waitFor(() => expect(appendsOf(received)).toEqual([FTYP, MOOV]));
  });

  it('gives the new port the init of the type the buffer changed to', async () => {
    const { connect, openSource, received } = newPage();
    const first = connect();
    const { buffer } = openSource();
    await wantAnnouncedSource(received, first.command);
    appendAndComplete(buffer, WEBM_INIT);
    buffer.changeType('video/mp4; codecs="avc1.64001f"');
    appendAndComplete(buffer, MP4_INIT);
    appendAndComplete(buffer, [0xd]);
    const sourceId = sourceIdOf(received);
    const second = connect();
    await new Promise(resolve => setTimeout(resolve, 10));
    received.length = 0;

    second.command({ t: 'want', sourceId });

    await vi.waitFor(() => expect(appendsOf(received)).toEqual([MP4_INIT]));
    expect(received.find(message => message.t === 'buffer')).toMatchObject({ mime: 'video/mp4; codecs="avc1.64001f"' });
  });

  it('gives the new port only the init bytes of an append that carried media after them', async () => {
    const CLUSTER = [0x1f, 0x43, 0xb6, 0x75, 0x09];
    const { connect, openSource, received } = newPage();
    const first = connect();
    const { buffer } = openSource();
    await wantAnnouncedSource(received, first.command);
    appendAndComplete(buffer, [...WEBM_INIT, ...CLUSTER]);
    const sourceId = sourceIdOf(received);
    const second = connect();
    await new Promise(resolve => setTimeout(resolve, 10));
    received.length = 0;

    second.command({ t: 'want', sourceId });

    await vi.waitFor(() => expect(appendsOf(received)).toEqual([WEBM_INIT]));
  });

  it('gives the new port only the ftyp and moov boxes of an fMP4 append that carried a fragment too', async () => {
    const FTYP = [0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70];
    const MOOV = [0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x76];
    const MOOF = [0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x66];
    const { connect, openSource, received } = newPage();
    const first = connect();
    const { buffer } = openSource('video/mp4; codecs="avc1.64001f"');
    await wantAnnouncedSource(received, first.command);
    appendAndComplete(buffer, [...FTYP, ...MOOV, ...MOOF]);
    const sourceId = sourceIdOf(received);
    const second = connect();
    await new Promise(resolve => setTimeout(resolve, 10));
    received.length = 0;

    second.command({ t: 'want', sourceId });

    await vi.waitFor(() => expect(appendsOf(received)).toEqual([[...FTYP, ...MOOV]]));
  });

  it('keeps evicting the oldest appends of a once-wanted source past the cap instead of overflowing', async () => {
    const { connect, openSource, received } = newPage();
    const first = connect();
    const { buffer } = openSource();
    await wantAnnouncedSource(received, first.command);
    appendAndComplete(buffer, WEBM_INIT);
    const sourceId = sourceIdOf(received);
    const second = connect();
    await new Promise(resolve => setTimeout(resolve, 10));
    for (let index = 0; index < 3; index += 1) appendAndComplete(buffer, new Uint8Array(20 * 1024 * 1024));
    appendAndComplete(buffer, [0xe]);
    received.length = 0;

    second.command({ t: 'want', sourceId });

    await vi.waitFor(() => expect(appendsOf(received).at(-1)).toEqual([0xe]));
    expect(received.some(message => message.t === 'overflow')).toBe(false);
    expect(appendsOf(received)[0]).toEqual(WEBM_INIT);
  });

  it('gives the new port nothing of a buffer the page removed', async () => {
    const { connect, openSource, received } = newPage();
    const first = connect();
    const { source, buffer } = openSource();
    await wantAnnouncedSource(received, first.command);
    appendAndComplete(buffer, WEBM_INIT);
    source.removeSourceBuffer(buffer);
    const sourceId = sourceIdOf(received);
    const second = connect();
    await new Promise(resolve => setTimeout(resolve, 10));
    received.length = 0;

    second.command({ t: 'want', sourceId });
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(received.filter(message => message.t === 'buffer' || message.t === 'append')).toEqual([]);
  });
});

describe('MSE hook: live and post-live detection', () => {
  const youTubePlayer = (state: { response: object | null; currentVideoId?: string }) => ({
    getPlayerResponse: () => state.response,
    getVideoData: () => (state.currentVideoId ? { video_id: state.currentVideoId } : {}),
  });

  const announcedLiveness = async (fake: FakePage) => {
    const { connect, openSource, received } = newPage(fake);
    connect();
    openSource();
    await vi.waitFor(() => expect(received.some(message => message.t === 'source')).toBe(true));
    return received.find(message => message.t === 'source');
  };

  it("announces a non-YouTube source as vod, leaving liveness to the video's duration", async () => {
    expect(await announcedLiveness({})).toHaveProperty('liveness', 'vod');
  });

  it("announces a YouTube source live from the current video's isLive flag", async () => {
    const player = youTubePlayer({
      response: { videoDetails: { videoId: 'now', isLive: true } },
      currentVideoId: 'now',
    });

    expect(await announcedLiveness({ player })).toHaveProperty('liveness', 'live');
  });

  it("announces a YouTube source live from the current video's isPostLiveDvr flag", async () => {
    const response = { videoDetails: { videoId: 'now', isLive: false, isPostLiveDvr: true } };

    expect(await announcedLiveness({ player: youTubePlayer({ response, currentVideoId: 'now' }) })).toHaveProperty(
      'liveness',
      'live',
    );
  });

  it('announces a YouTube source vod when the current video carries neither flag', async () => {
    const player = youTubePlayer({
      response: { videoDetails: { videoId: 'now', isLive: false } },
      currentVideoId: 'now',
    });

    expect(await announcedLiveness({ player })).toHaveProperty('liveness', 'vod');
  });

  it('never trusts a player response left over from the previous video after SPA navigation', async () => {
    const state = { response: { videoDetails: { videoId: 'previous', isLive: false } }, currentVideoId: 'now' };
    const { connect, openSource, received } = newPage({ player: youTubePlayer(state) });
    connect();
    const { buffer } = openSource();
    await vi.waitFor(() => expect(received.some(message => message.t === 'source')).toBe(true));
    expect(received.find(message => message.t === 'source')).toHaveProperty('liveness', 'unknown');

    state.response = { videoDetails: { videoId: 'now', isLive: true } };
    appendAndComplete(buffer, [1]);
    appendAndComplete(buffer, [2]);

    await vi.waitFor(() => expect(received.some(message => message.t === 'liveness')).toBe(true));
    expect(received.filter(message => message.t === 'liveness')).toEqual([
      { t: 'liveness', sourceId: sourceIdOf(received), liveness: 'live' },
    ]);
  });

  it("keeps a YouTube page's source unknown until its player exists, then announces its liveness", async () => {
    const fake: FakePage = { href: 'https://www.youtube.com/watch?v=now' };
    const { connect, openSource, received } = newPage(fake);
    connect();
    const { buffer } = openSource();
    await vi.waitFor(() => expect(received.some(message => message.t === 'source')).toBe(true));
    expect(received.find(message => message.t === 'source')).toHaveProperty('liveness', 'unknown');

    fake.player = youTubePlayer({ response: { videoDetails: { videoId: 'now', isLive: false } } });
    appendAndComplete(buffer, [1]);

    await vi.waitFor(() =>
      expect(received.find(message => message.t === 'liveness')).toHaveProperty('liveness', 'vod'),
    );
  });

  it("identifies the current video from the page URL when the player can't say", async () => {
    const player = youTubePlayer({ response: { videoDetails: { videoId: 'previous', isLive: true } } });

    expect(await announcedLiveness({ player, href: 'https://www.youtube.com/watch?v=now' })).toHaveProperty(
      'liveness',
      'unknown',
    );
    expect(await announcedLiveness({ player, href: 'https://www.youtube.com/shorts/previous' })).toHaveProperty(
      'liveness',
      'live',
    );
  });
});

describe('MSE hook: YouTube video identity', () => {
  const WATCH = 'https://www.youtube.com/watch?v=abc&t=42&list=PL1';

  interface PlayerState {
    videoId?: string;
    responseVideoId?: string;
    lengthSeconds?: string;
    classes?: string[];
  }

  const ownerPlayer = (state: PlayerState) => {
    const listeners = new Map<string, () => void>();
    return {
      classList: { contains: (name: string) => state.classes?.includes(name) ?? false },
      getVideoData: () => (state.videoId ? { video_id: state.videoId } : {}),
      getPlayerResponse: () => ({
        videoDetails: { videoId: state.responseVideoId ?? state.videoId, lengthSeconds: state.lengthSeconds ?? '30' },
      }),
      addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
      fire: (name: string) => listeners.get(name)?.(),
    };
  };

  const claimOf = (video: { getAttribute(name: string): string | null }) => {
    const raw = video.getAttribute(HOOK_IDENTITY_ATTR);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  };

  const referenceTo = (id: string, expectedDurationSec = 30) => ({
    kind: 'stable',
    namespace: 'yt',
    id,
    expectedDurationSec,
  });
  const UNIDENTIFIABLE = { kind: 'unidentifiable' };

  it.each([
    ['the watch player', 'https://www.youtube.com/watch?v=abc'],
    ['the Shorts player, while the page URL still names the previous short', 'https://www.youtube.com/shorts/old'],
    ['an inline hover preview on the home page', 'https://www.youtube.com/'],
  ])('names the video %s plays by its own video id and reported length', (_, href) => {
    const { playSource } = newPage({ href, player: ownerPlayer({}) });
    const { source, video, objectUrl } = playSource(ownerPlayer({ videoId: 'abc', lengthSeconds: '30' }));

    expect(claimOf(video)).toEqual({ objectUrl, reference: referenceTo('abc') });

    source.duration = 30.021;

    expect(claimOf(video)).toEqual({ objectUrl, reference: referenceTo('abc') });
  });

  it("binds a source assigned through setAttribute('src') too", () => {
    const { playSource } = newPage({ href: WATCH });
    const { source, video, objectUrl } = playSource(ownerPlayer({ videoId: 'abc' }), 'attribute');
    source.duration = 30;

    expect(claimOf(video)).toEqual({ objectUrl, reference: referenceTo('abc') });
  });

  it("keeps re-evaluating a source whose duration is not the claimed video's", () => {
    const state: PlayerState = { videoId: 'abc', lengthSeconds: '30' };
    const { playSource } = newPage({ href: WATCH });
    const { source, buffer, video, objectUrl } = playSource(ownerPlayer(state));
    source.duration = 15.2;
    appendAndComplete(buffer, [1]);
    Object.assign(state, { videoId: 'def', lengthSeconds: '15' });
    appendAndComplete(buffer, [2]);

    expect(claimOf(video)).toEqual({ objectUrl, reference: referenceTo('def', 15) });
  });

  it('settles a source once an append finds its duration matching', () => {
    const state: PlayerState = { videoId: 'abc', lengthSeconds: '30' };
    const { playSource } = newPage({ href: WATCH });
    const { source, buffer, video, objectUrl } = playSource(ownerPlayer(state));
    source.duration = 30;
    appendAndComplete(buffer, [1]);
    state.videoId = 'def';
    appendAndComplete(buffer, [2]);

    expect(claimOf(video)).toEqual({ objectUrl, reference: referenceTo('abc') });
  });

  it('never trusts a player response left over from another video', () => {
    const { playSource } = newPage({ href: WATCH });
    const { source, video, objectUrl } = playSource(ownerPlayer({ videoId: 'abc', responseVideoId: 'previous' }));
    source.duration = 30;

    expect(claimOf(video)).toEqual({ objectUrl, reference: UNIDENTIFIABLE });
  });

  it.each(['ad-showing', 'ad-interrupting'])(
    'claims a source unidentifiable while its player shows %s, re-evaluating it on each append',
    adClass => {
      const state: PlayerState = { videoId: 'abc', classes: [adClass] };
      const { playSource } = newPage({ href: WATCH });
      const { source, buffer, video, objectUrl } = playSource(ownerPlayer(state));
      source.duration = 30;
      appendAndComplete(buffer, [1]);

      expect(claimOf(video)).toEqual({ objectUrl, reference: UNIDENTIFIABLE });

      state.classes = [];
      appendAndComplete(buffer, [2]);

      expect(claimOf(video)).toEqual({ objectUrl, reference: referenceTo('abc') });
    },
  );

  it('claims a source unidentifiable between the player reporting an ad start and its finish', () => {
    const player = ownerPlayer({ videoId: 'abc' });
    const { playSource } = newPage({ href: WATCH });
    const first = playSource(player);
    player.fire('onAdStart');
    const ad = playSource(player);
    ad.source.duration = 30;
    appendAndComplete(ad.buffer, [1]);

    expect(claimOf(ad.video)).toEqual({ objectUrl: ad.objectUrl, reference: UNIDENTIFIABLE });

    player.fire('onAdFinish');
    appendAndComplete(ad.buffer, [2]);

    expect(claimOf(ad.video)).toHaveProperty('reference.kind', 'stable');
    expect(claimOf(first.video)).toHaveProperty('reference.id', 'abc');
  });

  it("never overwrites a video's claim for its new source from its previous one", () => {
    const { playSource } = newPage({ href: WATCH });
    const player = ownerPlayer({ videoId: 'abc' });
    const previous = playSource(player);
    const next = playSource(player);
    previous.video.src = next.objectUrl;
    previous.source.duration = 30;
    appendAndComplete(previous.buffer, [1]);

    expect(claimOf(previous.video)).toEqual({ objectUrl: next.objectUrl, reference: referenceTo('abc') });
  });

  it('claims nothing for a video outside YouTube', () => {
    const { playSource } = newPage({ href: 'https://www.example.test/watch' });
    const { source, video } = playSource(ownerPlayer({ videoId: 'abc' }));
    source.duration = 30;

    expect(claimOf(video)).toBeNull();
  });
});
