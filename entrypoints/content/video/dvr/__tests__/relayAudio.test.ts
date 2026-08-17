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
  readyState = 0;
  duration = Number.NaN;
  error: { code: number } | null = null;
  private listeners = new Map<string, Set<EventListener>>();
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
  addEventListener = (type: string, listener: EventListener) => {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  };
  removeEventListener = (type: string, listener: EventListener) => {
    this.listeners.get(type)?.delete(listener);
  };
  dispatchEvent = (event: Event) => {
    this.listeners.get(event.type)?.forEach(listener => listener(event));
    return true;
  };
  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
}

interface FakeVideoState {
  volume: number;
  loop: boolean;
  paused: boolean;
  ended: boolean;
  currentTime: number;
  playbackRate: number;
  currentSrc: string;
  src: string;
}

/** muted/volume writes queue an async volumechange, matching browser event delivery. */
const makeVideo = (overrides: Partial<FakeVideoState & { muted: boolean; volume: number }> = {}): HTMLVideoElement => {
  const listeners = new Map<string, Set<EventListener>>();
  let muted = overrides.muted ?? true;
  let volume = overrides.volume ?? 1;
  const video = {
    loop: true,
    paused: false,
    ended: false,
    currentTime: 10,
    playbackRate: 1,
    currentSrc: 'https://cdn.example/clip.mp4',
    src: 'https://cdn.example/clip.mp4',
    get muted() {
      return muted;
    },
    set muted(value: boolean) {
      if (muted === value) return;
      muted = value;
      setTimeout(() => video.dispatchEvent(new Event('volumechange')), 0);
    },
    get volume() {
      return volume;
    },
    set volume(value: number) {
      if (volume === value) return;
      volume = value;
      setTimeout(() => video.dispatchEvent(new Event('volumechange')), 0);
    },
    addEventListener: (type: string, listener: EventListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: (event: Event) => {
      listeners.get(event.type)?.forEach(listener => listener(event));
      return true;
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'muted' && key !== 'volume')),
  };
  return video as unknown as HTMLVideoElement;
};

const audioEl = () => FakeAudio.instances.at(-1)!;

const flush = () => vi.advanceTimersByTimeAsync(0);

/** Engage and settle: fire canplay, drain the queued volumechange from the force-mute. */
const engage = async (video: HTMLVideoElement, onSiteChange?: (audible: boolean) => void) => {
  const result = mod.engageRelayAudio(video, () => 2, onSiteChange);
  audioEl().dispatchEvent(new Event('canplay'));
  await flush();
  return result;
};

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

  it('reports terminal without a resolvable URL', async () => {
    const video = makeVideo({ currentSrc: '', src: '' });
    await expect(mod.engageRelayAudio(video, () => 2)).resolves.toBe('terminal');
    expect(mod.isRelayAudioEngaged(video)).toBe(false);
  });

  it('engages from the original URL: silences the page, remembers site intent, plays at currentTime - D', async () => {
    const video = makeVideo({ muted: false, volume: 0.5 });
    await expect(engage(video)).resolves.toBe('engaged');
    const audio = audioEl();
    expect(audio.src).toBe('https://cdn.example/clip.mp4');
    expect(video.volume).toBe(0);
    expect(video.muted).toBe(false);
    expect(audio.muted).toBe(false);
    expect(audio.volume).toBe(0.5);
    expect(audio.currentTime).toBe(8);
    expect(audio.paused).toBe(false);
    expect(mod.isRelayAudioEngaged(video)).toBe(true);
  });

  it('a buffering timeout reports transient and a later engage retries', async () => {
    const video = makeVideo();
    const first = mod.engageRelayAudio(video, () => 2);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(first).resolves.toBe('transient');
    expect(mod.isRelayAudioEngaged(video)).toBe(false);

    await expect(engage(video)).resolves.toBe('engaged');
  });

  it('an unsupported source reports terminal and short-circuits retries for the same src', async () => {
    const video = makeVideo();
    const first = mod.engageRelayAudio(video, () => 2);
    const audio = audioEl();
    audio.error = { code: 4 };
    audio.dispatchEvent(new Event('error'));
    await expect(first).resolves.toBe('terminal');

    const instancesBefore = FakeAudio.instances.length;
    await expect(mod.engageRelayAudio(video, () => 2)).resolves.toBe('terminal');
    expect(FakeAudio.instances.length).toBe(instancesBefore);
  });

  it('mirrors a site unmute onto the relay element under async delivery; the page stays silent', async () => {
    const video = makeVideo({ muted: true });
    const onSiteChange = vi.fn();
    await engage(video, onSiteChange);
    const audio = audioEl();
    expect(audio.muted).toBe(true);

    video.muted = false;
    await flush();
    expect(onSiteChange).toHaveBeenCalledWith(true);
    expect(audio.muted).toBe(false);
    expect(video.volume).toBe(0);

    // The module's own async-delivered silencing must not read as site intent.
    await flush();
    expect(onSiteChange).toHaveBeenCalledTimes(1);
    expect(audio.muted).toBe(false);
  });

  it('a site volume write while silenced is recorded, mirrored, and re-silenced', async () => {
    const video = makeVideo({ muted: false, volume: 1 });
    await engage(video);
    const audio = audioEl();
    expect(video.volume).toBe(0);

    video.volume = 0.3;
    await flush();
    await flush();
    expect(audio.volume).toBe(0.3);
    expect(video.volume).toBe(0);

    mod.releaseRelayAudio(video);
    expect(video.volume).toBe(0.3);
  });

  it('a site mute after unmute silences the relay element and restores on release', async () => {
    const video = makeVideo({ muted: false });
    await engage(video);
    const audio = audioEl();
    expect(audio.muted).toBe(false);

    video.muted = true;
    await flush();
    expect(audio.muted).toBe(true);

    mod.releaseRelayAudio(video);
    await flush();
    expect(video.muted).toBe(true);
    expect(video.volume).toBe(1);
    expect(mod.isRelayAudioEngaged(video)).toBe(false);
  });

  it('release restores the site volume and tears the element down', async () => {
    const video = makeVideo({ muted: false, volume: 0.8 });
    await engage(video);
    expect(video.volume).toBe(0);
    mod.releaseRelayAudio(video);
    expect(video.volume).toBe(0.8);
    expect(video.muted).toBe(false);
    expect(audioEl().pause).toHaveBeenCalled();
    expect(audioEl().src).toBe('');
  });

  it('hard-resyncs on large drift and nudges rate inside the window', async () => {
    const video = makeVideo({ currentTime: 20 });
    await engage(video);
    const audio = audioEl();
    expect(audio.currentTime).toBe(18);

    audio.currentTime = 15;
    await vi.advanceTimersByTimeAsync(500);
    expect(audio.currentTime).toBe(18);
    expect(audio.playbackRate).toBe(1);

    audio.currentTime = 17.9;
    await vi.advanceTimersByTimeAsync(500);
    expect(audio.currentTime).toBe(17.9);
    expect(audio.playbackRate).toBeCloseTo(1.02);
  });

  it('plays the previous pass tail after a loop wrap', async () => {
    const video = makeVideo({ currentTime: 10, loop: true });
    await engage(video);
    const audio = audioEl();
    audio.duration = 12;

    video.currentTime = 0.5;
    await vi.advanceTimersByTimeAsync(500);
    expect(audio.currentTime).toBeCloseTo(10.5);
    expect(audio.paused).toBe(false);
  });

  it('pauses with the video and while presentation is inside the pinned start', async () => {
    const video = makeVideo({ currentTime: 1 });
    await engage(video);
    expect(audioEl().paused).toBe(true);

    video.currentTime = 5;
    await vi.advanceTimersByTimeAsync(500);
    expect(audioEl().paused).toBe(false);

    (video as { paused: boolean }).paused = true;
    video.dispatchEvent(new Event('pause'));
    expect(audioEl().paused).toBe(true);
  });

  it('drain keeps the tail playing for D wall-clock seconds past the ended pause', async () => {
    const video = makeVideo({ currentTime: 10 });
    await engage(video);
    const audio = audioEl();
    expect(audio.paused).toBe(false);

    (video as { paused: boolean; ended: boolean }).paused = true;
    (video as { paused: boolean; ended: boolean }).ended = true;
    video.dispatchEvent(new Event('pause'));
    expect(audio.paused).toBe(true);

    mod.drainRelayAudio(video);
    expect(audio.paused).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(audio.paused).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(audio.paused).toBe(true);
  });

  it('a re-engage after a drained end leaves drain mode so replay audio returns', async () => {
    const video = makeVideo({ currentTime: 10 });
    await engage(video);
    const audio = audioEl();
    (video as { paused: boolean; ended: boolean }).paused = true;
    (video as { paused: boolean; ended: boolean }).ended = true;
    video.dispatchEvent(new Event('pause'));
    mod.drainRelayAudio(video);
    await vi.advanceTimersByTimeAsync(2100);
    expect(audio.paused).toBe(true);

    (video as { paused: boolean; ended: boolean }).paused = false;
    (video as { paused: boolean; ended: boolean }).ended = false;
    video.currentTime = 5;
    await expect(mod.engageRelayAudio(video, () => 2)).resolves.toBe('engaged');
    await vi.advanceTimersByTimeAsync(500);
    expect(audio.paused).toBe(false);
    expect(audio.currentTime).toBe(3);
  });

  describe('mute hold', () => {
    it('silences preserving site intent; release restores it', async () => {
      const video = makeVideo({ muted: false, volume: 0.7 });
      mod.holdPageMute(video);
      expect(video.volume).toBe(0);
      await flush();
      mod.releaseMuteHold(video);
      expect(video.volume).toBe(0.7);
      expect(mod.hasMuteIntent(video)).toBe(false);
    });

    it('reports a site unmute during the hold without misreading its own write', async () => {
      const video = makeVideo({ muted: true });
      const onSiteChange = vi.fn();
      mod.holdPageMute(video, onSiteChange);
      await flush();
      expect(onSiteChange).not.toHaveBeenCalled();

      video.muted = false;
      await flush();
      expect(onSiteChange).toHaveBeenCalledWith(true);

      mod.releaseMuteHold(video);
      expect(video.muted).toBe(false);
      expect(video.volume).toBe(1);
    });

    it('hands the tracked intent over to a relay engage', async () => {
      const video = makeVideo({ muted: false });
      mod.holdPageMute(video);
      await flush();
      await engage(video);
      expect(audioEl().muted).toBe(false);
      expect(audioEl().volume).toBe(1);
      expect(video.volume).toBe(0);

      mod.releaseMuteHold(video);
      expect(video.volume).toBe(0);

      mod.releaseRelayAudio(video);
      expect(video.volume).toBe(1);
    });
  });
});
