import { beforeEach, describe, expect, it, vi } from 'vitest';

import { completeContentTiming, markReceived, markSent, startContentTiming } from '@/utils/logging/contentTiming';
import { emitEvent } from '@/utils/logging/emitEvent';

vi.mock('@/utils/logging/emitEvent', () => ({ emitEvent: vi.fn() }));

const SRC = 'https://example.com/a.jpg';

describe('contentTiming', () => {
  beforeEach(() => {
    vi.mocked(emitEvent).mockClear();
    completeContentTiming(SRC, { status: 'skipped' });
  });

  it('preserves the baseline and sent/received marks across a re-entrant start', () => {
    startContentTiming(SRC, 'example.com');
    markSent(SRC);
    startContentTiming(SRC, 'example.com');
    markReceived(SRC);

    completeContentTiming(SRC, { status: 'success' });

    const event = vi.mocked(emitEvent).mock.calls[0]?.[0];
    expect(typeof event?.sendMs).toBe('number');
    expect(typeof event?.waitMs).toBe('number');
  });

  it('starts fresh after completion', () => {
    startContentTiming(SRC, 'example.com');
    completeContentTiming(SRC, { status: 'success' });
    vi.mocked(emitEvent).mockClear();

    startContentTiming(SRC, 'example.com');
    completeContentTiming(SRC, { status: 'success' });

    expect(emitEvent).toHaveBeenCalledTimes(1);
  });
});
