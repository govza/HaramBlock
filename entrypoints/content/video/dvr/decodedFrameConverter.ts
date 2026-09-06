import { getLogger } from '@/utils/telemetry';

import type { DecodedRingFrame } from '@/entrypoints/content/video/dvr/encodedFrameRing';

const log = getLogger('decodedFrameConverter');

export interface BitmapRingFrame extends DecodedRingFrame {
  readonly source: ImageBitmap;
}

export type ConvertedFrameHandler = (converted: DecodedRingFrame | null) => void;

export interface DecodedFrameConverter {
  convert(frame: DecodedRingFrame, onConverted: ConvertedFrameHandler): void;
  release(): void;
}

export type DecodedFrameConverterFactory = () => DecodedFrameConverter | null;

/**
 * A worker that stops answering (a GPU-backed frame's readback wedging on
 * the worker thread fires no error event) would hold the ring's whole decode
 * lookahead in flight forever; past this, the converter gives up on the
 * worker and the ring draws decoded frames on the main thread instead.
 */
export const CONVERSION_TIMEOUT_MS = 1000;

const CONVERTER_WORKER_SOURCE = [
  'let canvas = null;',
  'let ctx = null;',
  'onmessage = event => {',
  '  const { id, frame } = event.data;',
  '  try {',
  '    if (!canvas || canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {',
  '      canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);',
  "      ctx = canvas.getContext('2d');",
  '    }',
  '    ctx.drawImage(frame, 0, 0);',
  '    const bitmap = canvas.transferToImageBitmap();',
  '    postMessage({ id, bitmap }, [bitmap]);',
  '  } catch {',
  '    postMessage({ id, bitmap: null });',
  '  } finally {',
  '    frame.close();',
  '  }',
  '};',
].join('\n');

interface PendingConversion {
  readonly timestamp: number;
  readonly sentAt: number;
  readonly onConverted: ConvertedFrameHandler;
}

interface ConverterWorkerMessage {
  readonly id: number;
  readonly bitmap: ImageBitmap | null;
}

function bitmapRingFrame(bitmap: ImageBitmap, timestamp: number): BitmapRingFrame {
  return {
    source: bitmap,
    displayWidth: bitmap.width,
    displayHeight: bitmap.height,
    timestamp,
    close: () => bitmap.close(),
  };
}

export function decodedFrameConverterFactoryFor(isFirefox: boolean): DecodedFrameConverterFactory | null {
  return isFirefox ? createWorkerFrameConverter : null;
}

export function createWorkerFrameConverter(): DecodedFrameConverter | null {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
  let worker: Worker;
  let scriptUrl: string;
  try {
    scriptUrl = URL.createObjectURL(new Blob([CONVERTER_WORKER_SOURCE], { type: 'text/javascript' }));
    worker = new Worker(scriptUrl);
  } catch (error) {
    log.debug('dvr.frame_converter.unavailable', { error });
    return null;
  }
  const pending = new Map<number, PendingConversion>();
  let nextId = 0;
  let failed = false;
  let released = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;

  const shutDown = () => {
    if (watchdog !== null) clearTimeout(watchdog);
    watchdog = null;
    worker.terminate();
    URL.revokeObjectURL(scriptUrl);
  };
  const failAllPending = () => {
    const stranded = [...pending.values()];
    pending.clear();
    for (const conversion of stranded) conversion.onConverted(null);
  };
  const fail = (detail: string) => {
    if (failed) return;
    failed = true;
    log.warn('dvr.frame_converter.failed', { detail, pending: pending.size });
    shutDown();
    failAllPending();
  };
  const armWatchdog = () => {
    if (watchdog !== null) clearTimeout(watchdog);
    watchdog = null;
    const oldest = pending.values().next().value;
    if (!oldest) return;
    const remainingMs = Math.max(0, oldest.sentAt + CONVERSION_TIMEOUT_MS - performance.now());
    watchdog = setTimeout(() => {
      watchdog = null;
      const stillOldest = pending.values().next().value;
      if (!stillOldest) return;
      if (performance.now() - stillOldest.sentAt >= CONVERSION_TIMEOUT_MS) fail('timeout');
      else armWatchdog();
    }, remainingMs);
  };

  worker.onmessage = ({ data }: MessageEvent<ConverterWorkerMessage>) => {
    const conversion = pending.get(data.id);
    pending.delete(data.id);
    armWatchdog();
    if (!conversion) {
      data.bitmap?.close();
      return;
    }
    conversion.onConverted(data.bitmap ? bitmapRingFrame(data.bitmap, conversion.timestamp) : null);
  };
  worker.onerror = event => fail(event.message);

  return {
    convert: (frame, onConverted) => {
      if (failed || released) {
        onConverted(frame);
        return;
      }
      const id = nextId++;
      pending.set(id, { timestamp: frame.timestamp, sentAt: performance.now(), onConverted });
      try {
        worker.postMessage({ id, frame }, [frame as Transferable]);
        if (watchdog === null) armWatchdog();
      } catch (error) {
        pending.delete(id);
        log.debug('dvr.frame_converter.transfer_failed', { error });
        onConverted(frame);
      }
    },
    release: () => {
      if (released) return;
      released = true;
      if (!failed) shutDown();
      failAllPending();
    },
  };
}
