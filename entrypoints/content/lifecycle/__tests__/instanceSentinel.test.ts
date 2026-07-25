import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claimInstanceSentinel } from '@/entrypoints/content/lifecycle/instanceSentinel';

class FakeMutationObserver {
  static instances: FakeMutationObserver[] = [];
  disconnected = false;

  constructor(private readonly callback: MutationCallback) {
    FakeMutationObserver.instances.push(this);
  }

  observe(): void {}

  disconnect(): void {
    this.disconnected = true;
  }

  emit(): void {
    this.callback([], this as unknown as MutationObserver);
  }
}

class FakeRoot {
  private readonly attributes = new Map<string, string>();

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  clearAttributes(): void {
    this.attributes.clear();
  }
}

function subscribedObserver(): FakeMutationObserver {
  const observer = FakeMutationObserver.instances[0];
  if (!observer) throw new Error('subscribing created no MutationObserver');
  return observer;
}

describe('claimInstanceSentinel', () => {
  let root: FakeRoot;

  beforeEach(() => {
    root = new FakeRoot();
    FakeMutationObserver.instances = [];
    vi.stubGlobal('document', { documentElement: root });
    vi.stubGlobal('MutationObserver', FakeMutationObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('notifies the earlier instance when a successor claims the page', () => {
    const onSuperseded = claimInstanceSentinel();
    let notified = 0;
    onSuperseded(() => notified++);
    const observer = subscribedObserver();

    claimInstanceSentinel();
    observer.emit();

    expect(notified).toBe(1);
    expect(observer.disconnected).toBe(true);
  });

  it('ignores mutations that leave its own claim in place', () => {
    const onSuperseded = claimInstanceSentinel();
    let notified = 0;
    onSuperseded(() => notified++);
    const observer = subscribedObserver();

    observer.emit();

    expect(notified).toBe(0);
    expect(observer.disconnected).toBe(false);
  });

  it('does not treat a stripped sentinel as a successor and keeps watching', () => {
    const onSuperseded = claimInstanceSentinel();
    let notified = 0;
    onSuperseded(() => notified++);
    const observer = subscribedObserver();

    root.clearAttributes();
    observer.emit();

    expect(notified).toBe(0);
    expect(observer.disconnected).toBe(false);

    claimInstanceSentinel();
    observer.emit();

    expect(notified).toBe(1);
  });

  it('stops observing when the returned unsubscribe runs', () => {
    const onSuperseded = claimInstanceSentinel();
    const unsubscribe = onSuperseded(() => {});
    const observer = subscribedObserver();

    unsubscribe();

    expect(observer.disconnected).toBe(true);
  });
});
