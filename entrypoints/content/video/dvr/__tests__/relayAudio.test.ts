import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as RelayAudioModule from '@/entrypoints/content/video/dvr/relayAudio';

let mod: typeof RelayAudioModule;

class FakeAudio {
  static instances: FakeAudio[] = [];
  src: string;
  preload = '';
  loop = false;
  muted = false;
  volume = 1;
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  play = vi.fn(() => {
    this.paused = false;
    return Promise.resolve();
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  load = vi.fn();
  removeAttribute = vi.fn((name: string) => {
    if (name === 'src') this.src = '';
  });
  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
}

interface FakeVideo {
  muted: boolean;
  volume: number;
  loop: boolean;
  paused: boolean;
  ended: boolean;
  currentTime: number;
  playbackRate: number;
  addEventListener: HTMLVideoElement['addEventListener'];
  removeEventListener: HTMLVideoElement['removeEventListener'];
  dispatchEvent: (event: Event) => boolean;
}

const makeVideo = (overrides: Partial<FakeVideo> = {}): FakeVideo & HTMLVideoElement => {
  const listeners = new Map<string, Set<EventListener>>();
  const video: FakeVideo = {
    muted: true,
    volume: 1,
    loop: true,
    paused: false,
    ended: false,
    currentTime: 10,
    playbackRate: 1,
    addEventListener: ((type: string, listener: EventListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    }) as HTMLVideoElement['addEventListener'],
    removeEventListener: ((type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    }) as HTMLVideoElement['removeEventListener'],
    dispatchEvent: (event: Event) => {
      listeners.get(event.type)?.forEach(listener => listener(event));
      return true;
    },
    ...overrides,
  };
  return video as FakeVideo & HTMLVideoElement;
};

const audioEl = () => FakeAudio.instances.at(-1)!;

describe('relayAudio', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Audio', FakeAudio);
    FakeAudio.instances = [];
    vi.resetModules();
    mod = await import('@/entrypoints/content/video/dvr/relayAudio');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not engage without a blob URL', () => {
    const video = makeVideo();
    expect(mod.engageRelayAudio(video, null, () => 2)).toBe(false);
    expect(mod.isRelayAudioEngaged(video)).toBe(false);
  });

  it('engages: mutes the page element, remembers site intent, plays at currentTime - D', () => {
    const video = makeVideo({ muted: false, volume: 0.5 });
    expect(mod.engageRelayAudio(video, 'blob:page/x', () => 2)).toBe(true);
    const audio = audioEl();
    expect(video.muted).toBe(true);
    expect(audio.muted).toBe(false);
    expect(audio.volume).toBe(0.5);
    expect(audio.currentTime).toBe(8);
    expect(audio.paused).toBe(false);
    expect(mod.isRelayAudioEngaged(video)).toBe(true);
  });

  it('mirrors a site unmute onto the relay element and re-mutes the page', () => {
    const video = makeVideo({ muted: true });
    mod.engageRelayAudio(video, 'blob:page/x', () => 2);
    const audio = audioEl();
    expect(audio.muted).toBe(true);

    video.muted = false;
    video.dispatchEvent(new Event('volumechange'));
    expect(audio.muted).toBe(false);
    expect(video.muted).toBe(true);
  });

  it('release restores the site muted intent and tears the element down', () => {
    const video = makeVideo({ muted: false });
    mod.engageRelayAudio(video, 'blob:page/x', () => 2);
    mod.releaseRelayAudio(video);
    expect(video.muted).toBe(false);
    expect(audioEl().pause).toHaveBeenCalled();
    expect(audioEl().src).toBe('');
    expect(mod.isRelayAudioEngaged(video)).toBe(false);
  });

  it('hard-resyncs on large drift and nudges rate inside the window', () => {
    const video = makeVideo({ currentTime: 20 });
    mod.engageRelayAudio(video, 'blob:page/x', () => 2);
    const audio = audioEl();
    expect(audio.currentTime).toBe(18);

    audio.currentTime = 15; // 3s behind target: hard resync
    vi.advanceTimersByTime(500);
    expect(audio.currentTime).toBe(18);
    expect(audio.playbackRate).toBe(1);

    audio.currentTime = 17.9; // 0.1s behind: gentle catch-up
    vi.advanceTimersByTime(500);
    expect(audio.currentTime).toBe(17.9);
    expect(audio.playbackRate).toBeCloseTo(1.02);
  });

  it('pauses with the video and while presentation is inside the pinned start', () => {
    const video = makeVideo({ currentTime: 1 });
    mod.engageRelayAudio(video, 'blob:page/x', () => 2);
    // target < 0: nothing to say yet
    expect(audioEl().paused).toBe(true);

    video.currentTime = 5;
    vi.advanceTimersByTime(500);
    expect(audioEl().paused).toBe(false);

    video.paused = true;
    video.dispatchEvent(new Event('pause'));
    expect(audioEl().paused).toBe(true);
  });
});
