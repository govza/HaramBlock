import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as AudioDelayModule from '@/entrypoints/content/video/dvr/audioDelay';

let mod: typeof AudioDelayModule;

/**
 * Minimal WebAudio fakes tracking connections: the bug class here is routing
 * (a released DelayNode draining its buffered tail into the destination while
 * live audio also plays), so the tests assert graph shape, not samples.
 */
class FakeNode {
  connections = new Set<FakeNode>();
  connect = vi.fn((target: FakeNode) => {
    this.connections.add(target);
    return target;
  });
  disconnect = vi.fn(() => {
    this.connections.clear();
  });
}

class FakeDelayNode extends FakeNode {
  delayTime = { value: 0, setTargetAtTime: vi.fn() };
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = 'running';
  currentTime = 0;
  destination = new FakeNode();
  createdDelays: FakeDelayNode[] = [];
  resume = vi.fn(async () => {});
  createMediaElementSource = vi.fn(() => new FakeNode());
  createDelay = vi.fn(() => {
    const delay = new FakeDelayNode();
    this.createdDelays.push(delay);
    return delay;
  });
  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

const makeVideo = (): HTMLVideoElement =>
  ({ crossOrigin: 'anonymous', currentSrc: '', src: '' }) as unknown as HTMLVideoElement;

const context = () => FakeAudioContext.instances.at(-1)!;
const sourceOf = (ctx: FakeAudioContext) => ctx.createMediaElementSource.mock.results[0]!.value as FakeNode;

describe('audioDelay routing', () => {
  beforeEach(async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('location', new URL('https://example.com/page'));
    FakeAudioContext.instances = [];
    vi.resetModules();
    mod = await import('@/entrypoints/content/video/dvr/audioDelay');
  });

  it('engaging routes source through a delay into the destination', async () => {
    const video = makeVideo();
    await mod.engageAudioDelay(video, 2, () => true);
    const ctx = context();
    const source = sourceOf(ctx);
    const delay = ctx.createdDelays.at(-1)!;
    expect([...source.connections]).toEqual([delay]);
    expect(delay.connections.has(ctx.destination)).toBe(true);
    expect(delay.delayTime.value).toBe(2);
  });

  it('releasing disconnects the delay line so its buffered tail cannot play over live audio', async () => {
    const video = makeVideo();
    await mod.engageAudioDelay(video, 2, () => true);
    const ctx = context();
    mod.releaseAudioDelay(video);
    const source = sourceOf(ctx);
    expect([...source.connections]).toEqual([ctx.destination]);
    for (const delay of ctx.createdDelays) {
      expect(delay.connections.size).toBe(0);
    }
  });

  it('re-engaging uses a fresh delay line, not one holding a stale tail', async () => {
    const video = makeVideo();
    await mod.engageAudioDelay(video, 2, () => true);
    mod.releaseAudioDelay(video);
    await mod.engageAudioDelay(video, 3, () => true);
    const ctx = context();
    const source = sourceOf(ctx);
    const fresh = ctx.createdDelays.at(-1)!;
    expect(ctx.createdDelays.length).toBe(2);
    expect([...source.connections]).toEqual([fresh]);
    expect(fresh.delayTime.value).toBe(3);
  });

  it('updateAudioDelay ramps the engaged delay', async () => {
    const video = makeVideo();
    await mod.engageAudioDelay(video, 2, () => true);
    mod.updateAudioDelay(video, 2.5);
    const delay = context().createdDelays.at(-1)!;
    expect(delay.delayTime.setTargetAtTime).toHaveBeenCalledWith(2.5, 0, expect.any(Number));
  });

  it('abandons an engage whose DVR was torn down mid-resume', async () => {
    const video = makeVideo();
    await mod.engageAudioDelay(video, 2, () => false);
    const ctx = context();
    // Source may or may not exist, but nothing must be routed through a delay.
    expect(ctx.createdDelays.every(d => d.connections.size === 0)).toBe(true);
  });

  it('classifies delayability by source origin (WebAudio zeroes tainted samples)', () => {
    const cases: Array<[Partial<HTMLVideoElement>, boolean]> = [
      [{ srcObject: {} as MediaProvider }, true],
      [{ crossOrigin: 'anonymous', currentSrc: 'https://cdn.example.com/v.mp4' }, true],
      [{ currentSrc: 'blob:https://example.com/uuid' }, true],
      [{ currentSrc: 'data:video/mp4;base64,AAAA' }, true],
      [{ currentSrc: 'https://example.com/v.mp4' }, true],
      [{ currentSrc: 'https://cdn.example.com/v.mp4' }, false],
      [{ currentSrc: '', src: '' }, false],
    ];
    for (const [shape, expected] of cases) {
      const video = { crossOrigin: null, currentSrc: '', src: '', srcObject: null, ...shape } as HTMLVideoElement;
      expect(mod.isAudioDelayable(video), JSON.stringify(shape)).toBe(expected);
    }
  });

  it('reports a successful engage', async () => {
    expect(await mod.engageAudioDelay(makeVideo(), 2, () => true)).toBe('engaged');
  });

  it('reports permanent unavailability when the site already captured the element, and never retries', async () => {
    const video = makeVideo();
    vi.stubGlobal(
      'AudioContext',
      class extends FakeAudioContext {
        override createMediaElementSource = vi.fn(() => {
          throw new DOMException('already connected', 'InvalidStateError');
        });
      },
    );
    expect(await mod.engageAudioDelay(video, 2, () => true)).toBe('unavailable');
    const ctx = context();
    expect(await mod.engageAudioDelay(video, 2, () => true)).toBe('unavailable');
    expect(ctx.createMediaElementSource).toHaveBeenCalledTimes(1);
  });

  it('engages stacked while resume() awaits the user gesture share one attempt instead of racing the capture', async () => {
    // resume() stays pending until the gesture; every verdict retries the
    // engage meanwhile. Without the in-flight guard the resolved retries all
    // race createMediaElementSource, and the losers' InvalidStateError marks
    // a just-engaged element permanently unavailable.
    let releaseGesture!: () => void;
    const gesture = new Promise<void>(resolve => {
      releaseGesture = resolve;
    });
    vi.stubGlobal(
      'AudioContext',
      class extends FakeAudioContext {
        override state = 'suspended';
        override resume = vi.fn(async () => {
          await gesture;
          this.state = 'running';
        });
        override createMediaElementSource = vi.fn(() => {
          if (this.createMediaElementSource.mock.calls.length > 1) {
            throw new DOMException('already connected', 'InvalidStateError');
          }
          return new FakeNode();
        });
      },
    );
    const video = makeVideo();
    const attempts = [
      mod.engageAudioDelay(video, 2, () => true),
      mod.engageAudioDelay(video, 2, () => true),
      mod.engageAudioDelay(video, 2, () => true),
    ];
    releaseGesture();
    // Stacked calls share one outcome; the follow-up retry then engages.
    expect(await Promise.all(attempts)).toEqual(['engaged', 'engaged', 'engaged']);
    expect(context().createMediaElementSource).toHaveBeenCalledTimes(1);
    expect(await mod.engageAudioDelay(video, 2, () => true)).toBe('engaged');
  });

  it('reports a suspended context as deferred, then engages once a gesture resumes it', async () => {
    vi.stubGlobal(
      'AudioContext',
      class extends FakeAudioContext {
        override state = 'suspended';
        override resume = vi.fn(async () => {});
      },
    );
    const video = makeVideo();
    expect(await mod.engageAudioDelay(video, 2, () => true)).toBe('deferred');

    // A user gesture resumed the context: the same element engages normally.
    context().state = 'running';
    expect(await mod.engageAudioDelay(video, 2, () => true)).toBe('engaged');
    const source = sourceOf(context());
    expect([...source.connections]).toEqual([context().createdDelays.at(-1)]);
  });
});
