import { afterEach, describe, expect, it, vi } from 'vitest';

import { asCaptureFrame, createMockCodecs, fakeVideoFrame } from '@/entrypoints/content/video/dvr/__tests__/mockCodecs';
import {
  ENCODED_SESSION_CAP,
  createDvrFrameStore,
  isEncodedDvrRingEnabled,
  selectStoreKind,
  setEncodedDvrRingEnabled,
  type EncodedSessionSlots,
} from '@/entrypoints/content/video/dvr/frameStoreFactory';

const initialFlag = isEncodedDvrRingEnabled();

afterEach(() => {
  setEncodedDvrRingEnabled(initialFlag);
});

function fakeSlots(active = 0, cap = ENCODED_SESSION_CAP): EncodedSessionSlots & { count(): number } {
  let current = active;
  return {
    count: () => current,
    active: () => current,
    acquire: () => {
      if (current >= cap) return false;
      current++;
      return true;
    },
    release: () => {
      current--;
    },
  };
}

/** Distinct per test: the probe cache is keyed by geometry and module-global. */
let probeGeometrySeed = 1000;

function storeOptions(overrides: Partial<Parameters<typeof createDvrFrameStore>[0]> = {}) {
  probeGeometrySeed++;
  return {
    maxDurationSec: 10,
    maxBytes: Number.MAX_SAFE_INTEGER,
    probeWidth: probeGeometrySeed,
    probeHeight: 720,
    encodedIneligible: false,
    onEncodedError: vi.fn(),
    codecs: createMockCodecs(),
    probe: () => Promise.resolve(true),
    slots: fakeSlots(),
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('selectStoreKind matrix', () => {
  it.each([
    [{ enabled: true, probeSupported: true, activeEncodedSessions: 0, encodedIneligible: false }, 'encoded'],
    [{ enabled: false, probeSupported: true, activeEncodedSessions: 0, encodedIneligible: false }, 'raw'],
    [{ enabled: true, probeSupported: false, activeEncodedSessions: 0, encodedIneligible: false }, 'raw'],
    [{ enabled: true, probeSupported: true, activeEncodedSessions: 0, encodedIneligible: true }, 'raw'],
    [
      { enabled: true, probeSupported: true, activeEncodedSessions: ENCODED_SESSION_CAP - 1, encodedIneligible: false },
      'encoded',
    ],
    [
      { enabled: true, probeSupported: true, activeEncodedSessions: ENCODED_SESSION_CAP, encodedIneligible: false },
      'raw',
    ],
  ] as const)('%o -> %s', (input, expected) => {
    expect(selectStoreKind(input)).toBe(expected);
  });
});

describe('createDvrFrameStore', () => {
  it('counts a backing swap as one flush on top of the backings own flushes', async () => {
    setEncodedDvrRingEnabled(true);
    const store = createDvrFrameStore(storeOptions({ slots: fakeSlots() }));
    expect(store.flushes()).toBe(0);
    await settle();
    expect(store.kind()).toBe('encoded');
    expect(store.flushes()).toBe(1);
    store.release();
  });

  it('starts raw and upgrades to encoded when the probe passes', async () => {
    setEncodedDvrRingEnabled(true);
    const onKindChange = vi.fn();
    const slots = fakeSlots();
    const store = createDvrFrameStore(storeOptions({ onKindChange, slots }));
    expect(store.kind()).toBe('raw');
    expect(store.captureMode).toBe('bitmap');

    await settle();
    expect(store.kind()).toBe('encoded');
    expect(store.captureMode).toBe('video-frame');
    expect(onKindChange).toHaveBeenCalledWith('encoded');
    expect(slots.count()).toBe(1);

    store.release();
    expect(slots.count()).toBe(0);
  });

  it('stays raw when the probe fails', async () => {
    setEncodedDvrRingEnabled(true);
    const store = createDvrFrameStore(storeOptions({ probe: () => Promise.resolve(false) }));
    await settle();
    expect(store.kind()).toBe('raw');
    store.release();
  });

  it('stays raw and never probes when the flag is off', async () => {
    setEncodedDvrRingEnabled(false);
    const probe = vi.fn(() => Promise.resolve(true));
    const store = createDvrFrameStore(storeOptions({ probe }));
    await settle();
    expect(store.kind()).toBe('raw');
    expect(probe).not.toHaveBeenCalled();
    store.release();
  });

  it('stays raw and never probes for a webcodecs-ineligible session', async () => {
    setEncodedDvrRingEnabled(true);
    const probe = vi.fn(() => Promise.resolve(true));
    const store = createDvrFrameStore(storeOptions({ probe, encodedIneligible: true }));
    await settle();
    expect(store.kind()).toBe('raw');
    expect(probe).not.toHaveBeenCalled();
    store.release();
  });

  it('stays raw when the concurrency cap is exhausted', async () => {
    setEncodedDvrRingEnabled(true);
    const store = createDvrFrameStore(storeOptions({ slots: fakeSlots(ENCODED_SESSION_CAP) }));
    await settle();
    expect(store.kind()).toBe('raw');
    store.release();
  });

  it('a release before the probe resolves keeps the slot free and the codecs unused', async () => {
    setEncodedDvrRingEnabled(true);
    const slots = fakeSlots();
    let resolveProbe: (supported: boolean) => void = () => {};
    const store = createDvrFrameStore(
      storeOptions({ slots, probe: () => new Promise(resolve => (resolveProbe = resolve)) }),
    );
    store.release();
    resolveProbe(true);
    await settle();
    expect(slots.count()).toBe(0);
  });

  it('falls back to a fresh raw ring on a codec error and marks the session ineligible', async () => {
    setEncodedDvrRingEnabled(true);
    const onEncodedError = vi.fn();
    const onKindChange = vi.fn();
    const slots = fakeSlots();
    const codecs = createMockCodecs({ failAtEncodeCall: 3 });
    const store = createDvrFrameStore(storeOptions({ codecs, onEncodedError, onKindChange, slots }));
    await settle();
    expect(store.kind()).toBe('encoded');

    for (let i = 0; i < 5; i++) {
      store.push(asCaptureFrame(fakeVideoFrame(i / 30)), i / 30);
    }
    expect(onEncodedError).toHaveBeenCalledTimes(1);
    expect(store.kind()).toBe('raw');
    expect(onKindChange).toHaveBeenLastCalledWith('raw');
    expect(slots.count()).toBe(0);
    store.release();
  });
});
