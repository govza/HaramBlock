import { describe, expect, it } from 'vitest';

import { InstanceLifecycle, type InstanceLifecyclePorts } from '@/entrypoints/content/lifecycle/instanceLifecycle';

/** Records the teardown choreography as an ordered trace, since order is the contract. */
function makeHarness() {
  const trace: string[] = [];
  let supersede: () => void = () => {};
  let transportDeath: () => void = () => {};

  const harness = {
    trace,
    contextValid: false,
    stopPipelineError: null as Error | null,
    supersedeUnsubscribed: false,
    transportUnsubscribed: false,
    supersede: () => supersede(),
    transportDeath: () => transportDeath(),
    lifecycle: null as unknown as InstanceLifecycle,
  };

  const ports: InstanceLifecyclePorts = {
    isContextValid: () => harness.contextValid,
    onSuperseded: listener => {
      supersede = listener;
      return () => {
        harness.supersedeUnsubscribed = true;
      };
    },
    onTransportDead: listener => {
      transportDeath = listener;
      return () => {
        harness.transportUnsubscribed = true;
      };
    },
    stopPipeline: () => {
      trace.push('stopPipeline');
      if (harness.stopPipelineError) throw harness.stopPipelineError;
    },
    removeInitialStyling: () => trace.push('removeInitialStyling'),
  };

  harness.lifecycle = new InstanceLifecycle(ports);
  harness.lifecycle.start();
  return harness;
}

const FAIL_OPEN_ORDER = ['stopPipeline', 'removeInitialStyling'];

describe('InstanceLifecycle', () => {
  it('tears down in fail-open order when superseded', () => {
    const harness = makeHarness();

    harness.supersede();

    expect(harness.trace).toEqual(FAIL_OPEN_ORDER);
    expect(harness.lifecycle.isTornDown).toBe(true);
  });

  it('stops listening to both signals on teardown', () => {
    const harness = makeHarness();

    harness.supersede();

    expect(harness.supersedeUnsubscribed).toBe(true);
    expect(harness.transportUnsubscribed).toBe(true);
  });

  it('tears down when the transport dies with an invalidated context', () => {
    const harness = makeHarness();
    harness.contextValid = false;

    harness.transportDeath();

    expect(harness.trace).toEqual(FAIL_OPEN_ORDER);
  });

  it('ignores transport death while the context is still valid (service-worker idle kill)', () => {
    const harness = makeHarness();
    harness.contextValid = true;

    harness.transportDeath();

    expect(harness.trace).toEqual([]);
    expect(harness.lifecycle.isTornDown).toBe(false);
    expect(harness.transportUnsubscribed).toBe(false);
  });

  it('tears down exactly once when supersede arrives after invalidation', () => {
    const harness = makeHarness();

    harness.transportDeath();
    harness.supersede();

    expect(harness.trace).toEqual(FAIL_OPEN_ORDER);
  });

  it('tears down exactly once when invalidation arrives after supersede', () => {
    const harness = makeHarness();

    harness.supersede();
    harness.transportDeath();

    expect(harness.trace).toEqual(FAIL_OPEN_ORDER);
  });

  it('tears down exactly once on repeated supersede signals', () => {
    const harness = makeHarness();

    harness.supersede();
    harness.supersede();

    expect(harness.trace).toEqual(FAIL_OPEN_ORDER);
  });

  it('still tears down on supersede after an ignored idle-kill signal', () => {
    const harness = makeHarness();
    harness.contextValid = true;

    harness.transportDeath();
    harness.supersede();

    expect(harness.trace).toEqual(FAIL_OPEN_ORDER);
  });

  it('runs the remaining teardown steps when one throws', () => {
    const harness = makeHarness();
    harness.stopPipelineError = new Error('pipeline already broken');

    harness.supersede();

    expect(harness.trace).toEqual(FAIL_OPEN_ORDER);
    expect(harness.lifecycle.isTornDown).toBe(true);
  });
});
