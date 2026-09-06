import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONVERSION_TIMEOUT_MS,
  createWorkerFrameConverter,
  decodedFrameConverterFactoryFor,
} from '@/entrypoints/content/video/dvr/decodedFrameConverter';

import type { DecodedRingFrame } from '@/entrypoints/content/video/dvr/encodedFrameRing';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  readonly posted: { id: number; frame: unknown }[] = [];
  terminated = false;
  throwOnPost = false;

  constructor(readonly url: string) {
    FakeWorker.instances.push(this);
  }

  postMessage(message: { id: number; frame: unknown }): void {
    if (this.throwOnPost) throw new Error('not transferable');
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(id: number, bitmap: { width: number; height: number; close(): void } | null): void {
    this.onmessage?.({ data: { id, bitmap } });
  }

  fail(): void {
    this.onerror?.({ message: 'blocked by csp' });
  }
}

function fakeBitmap(width = 640, height = 360) {
  const bitmap = { width, height, closed: false, close: () => {} };
  bitmap.close = () => {
    bitmap.closed = true;
  };
  return bitmap;
}

function decodedFrame(timestamp: number): DecodedRingFrame & { closed: boolean } {
  const frame = { displayWidth: 640, displayHeight: 360, timestamp, closed: false, close: () => {} };
  frame.close = () => {
    frame.closed = true;
  };
  return frame;
}

function installFakeWorker() {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('OffscreenCanvas', class {});
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} });
  vi.stubGlobal('Blob', class {});
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('decodedFrameConverterFactoryFor', () => {
  it('only Firefox converts decoded frames off the main thread', () => {
    expect(decodedFrameConverterFactoryFor(false)).toBeNull();
    expect(decodedFrameConverterFactoryFor(true)).toBe(createWorkerFrameConverter);
  });
});

describe('createWorkerFrameConverter', () => {
  it('returns null where workers or OffscreenCanvas are missing', () => {
    vi.stubGlobal('Worker', undefined);
    expect(createWorkerFrameConverter()).toBeNull();
  });

  it('hands each frame to the worker and resolves it as a bitmap-backed frame with the same timestamp', () => {
    installFakeWorker();
    const converter = createWorkerFrameConverter()!;
    const worker = FakeWorker.instances[0]!;
    const onConverted = vi.fn();
    converter.convert(decodedFrame(42_000), onConverted);
    expect(worker.posted).toHaveLength(1);

    const bitmap = fakeBitmap(1280, 720);
    worker.reply(worker.posted[0]!.id, bitmap);
    const converted = onConverted.mock.calls[0]![0] as DecodedRingFrame & { source: unknown };
    expect(converted.source).toBe(bitmap);
    expect(converted.timestamp).toBe(42_000);
    expect(converted.displayWidth).toBe(1280);
    converted.close();
    expect(bitmap.closed).toBe(true);
  });

  it('reports a worker-side failure for that frame as null', () => {
    installFakeWorker();
    const converter = createWorkerFrameConverter()!;
    const worker = FakeWorker.instances[0]!;
    const onConverted = vi.fn();
    converter.convert(decodedFrame(1), onConverted);
    worker.reply(worker.posted[0]!.id, null);
    expect(onConverted).toHaveBeenCalledWith(null);
  });

  it('a worker error strands in-flight frames and passes later frames through unconverted', () => {
    installFakeWorker();
    const converter = createWorkerFrameConverter()!;
    const worker = FakeWorker.instances[0]!;
    const stranded = vi.fn();
    converter.convert(decodedFrame(1), stranded);
    worker.fail();
    expect(stranded).toHaveBeenCalledWith(null);
    expect(worker.terminated).toBe(true);

    const later = decodedFrame(2);
    const passedThrough = vi.fn();
    converter.convert(later, passedThrough);
    expect(passedThrough).toHaveBeenCalledWith(later);
    expect(worker.posted).toHaveLength(1);
  });

  it('passes a frame through when the transfer itself throws', () => {
    installFakeWorker();
    const converter = createWorkerFrameConverter()!;
    const worker = FakeWorker.instances[0]!;
    worker.throwOnPost = true;
    const frame = decodedFrame(3);
    const onConverted = vi.fn();
    converter.convert(frame, onConverted);
    expect(onConverted).toHaveBeenCalledWith(frame);
  });

  it('release terminates the worker, strands in-flight frames, and closes a bitmap arriving late', () => {
    installFakeWorker();
    const converter = createWorkerFrameConverter()!;
    const worker = FakeWorker.instances[0]!;
    const stranded = vi.fn();
    converter.convert(decodedFrame(1), stranded);
    converter.release();
    expect(worker.terminated).toBe(true);
    expect(stranded).toHaveBeenCalledWith(null);

    const late = fakeBitmap();
    worker.reply(0, late);
    expect(late.closed).toBe(true);
  });
});

describe('createWorkerFrameConverter watchdog', () => {
  it('a worker that stops answering fails over: stranded frames are nulled, later frames pass through', () => {
    vi.useFakeTimers();
    try {
      installFakeWorker();
      const converter = createWorkerFrameConverter()!;
      const worker = FakeWorker.instances[0]!;
      const stranded = [vi.fn(), vi.fn()];
      converter.convert(decodedFrame(1), stranded[0]!);
      vi.advanceTimersByTime(CONVERSION_TIMEOUT_MS / 2);
      converter.convert(decodedFrame(2), stranded[1]!);
      vi.advanceTimersByTime(CONVERSION_TIMEOUT_MS / 2 - 1);
      expect(worker.terminated).toBe(false);

      vi.advanceTimersByTime(2);
      expect(worker.terminated).toBe(true);
      expect(stranded[0]).toHaveBeenCalledWith(null);
      expect(stranded[1]).toHaveBeenCalledWith(null);

      const later = decodedFrame(3);
      const passedThrough = vi.fn();
      converter.convert(later, passedThrough);
      expect(passedThrough).toHaveBeenCalledWith(later);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a worker that keeps answering never trips the watchdog', () => {
    vi.useFakeTimers();
    try {
      installFakeWorker();
      const converter = createWorkerFrameConverter()!;
      const worker = FakeWorker.instances[0]!;
      for (let i = 0; i < 5; i++) {
        converter.convert(decodedFrame(i), vi.fn());
        vi.advanceTimersByTime(CONVERSION_TIMEOUT_MS / 2);
        worker.reply(worker.posted[i]!.id, fakeBitmap());
      }
      vi.advanceTimersByTime(CONVERSION_TIMEOUT_MS * 2);
      expect(worker.terminated).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
