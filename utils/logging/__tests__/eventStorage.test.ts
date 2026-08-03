import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import {
  storeWideEvent,
  mergeContentEvent,
  getEvents,
  clearEvents,
  __resetEventBufferForTests,
} from '@/utils/logging/eventStorage';

import type { WideEvent } from '@/utils/logging/types';

const STORAGE_KEY = 'wideEvents';

const makeEvent = (overrides: Partial<WideEvent> = {}): WideEvent => ({
  reqId: 'req-1',
  src: 'https://example.com/img.png',
  hostname: 'example.com',
  context: 'background',
  timestamp: Date.now(),
  status: 'success',
  totalMs: 10,
  version: 'test',
  ...overrides,
});

const readStoredEvents = async (): Promise<WideEvent[]> => {
  const result = await browser.storage.session.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as WideEvent[]) ?? [];
};

describe('eventStorage', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    __resetEventBufferForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('buffers events in memory and flushes to storage once, debounced', async () => {
    const setSpy = vi.spyOn(browser.storage.session, 'set');

    await storeWideEvent(makeEvent({ reqId: 'a' }));
    await storeWideEvent(makeEvent({ reqId: 'b' }));
    await storeWideEvent(makeEvent({ reqId: 'c' }));

    expect(setSpy).not.toHaveBeenCalled();
    expect(await readStoredEvents()).toHaveLength(0);

    await vi.runAllTimersAsync();

    expect(setSpy).toHaveBeenCalledTimes(1);
    expect((await readStoredEvents()).map(e => e.reqId)).toEqual(['a', 'b', 'c']);
  });

  it('getEvents returns buffered events before the flush lands', async () => {
    await storeWideEvent(makeEvent({ reqId: 'a' }));
    expect((await getEvents()).map(e => e.reqId)).toEqual(['a']);
  });

  it('seeds the buffer from storage so pre-restart events survive', async () => {
    await browser.storage.session.set({ [STORAGE_KEY]: [makeEvent({ reqId: 'old' })] });

    await storeWideEvent(makeEvent({ reqId: 'new' }));
    await vi.runAllTimersAsync();

    expect((await readStoredEvents()).map(e => e.reqId)).toEqual(['old', 'new']);
  });

  it('caps the buffer at 500 events', async () => {
    for (let i = 0; i < 505; i++) {
      await storeWideEvent(makeEvent({ reqId: `r${i}` }));
    }
    await vi.runAllTimersAsync();

    const stored = await readStoredEvents();
    expect(stored).toHaveLength(500);
    expect(stored[0]?.reqId).toBe('r5');
    expect(stored[499]?.reqId).toBe('r504');
  });

  it('merges content timing into the buffered background event', async () => {
    await storeWideEvent(makeEvent({ reqId: 'm', context: 'background' }));

    const merged = await mergeContentEvent(
      makeEvent({ reqId: 'm', context: 'content', sendMs: 5, waitMs: 7, styleMs: 2 }),
    );

    expect(merged).not.toBeNull();
    expect(merged?.sendMs).toBe(5);

    await vi.runAllTimersAsync();
    const stored = await readStoredEvents();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.waitMs).toBe(7);
  });

  it('mergeContentEvent returns null when no background event matches', async () => {
    const merged = await mergeContentEvent(makeEvent({ reqId: 'missing', context: 'content' }));
    expect(merged).toBeNull();
  });

  it('clearEvents drops the buffer, storage, and any pending flush', async () => {
    const setSpy = vi.spyOn(browser.storage.session, 'set');
    await storeWideEvent(makeEvent({ reqId: 'a' }));

    await clearEvents();
    await vi.runAllTimersAsync();

    expect(await getEvents()).toHaveLength(0);
    expect(await readStoredEvents()).toHaveLength(0);
    expect(setSpy).not.toHaveBeenCalled();
  });
});
