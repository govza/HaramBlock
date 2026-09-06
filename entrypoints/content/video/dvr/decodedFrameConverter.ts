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
  try {
    const url = URL.createObjectURL(new Blob([CONVERTER_WORKER_SOURCE], { type: 'text/javascript' }));
    worker = new Worker(url);
    URL.revokeObjectURL(url);
  } catch (error) {
    log.debug('dvr.frame_converter.unavailable', { error });
    return null;
  }
  const pending = new Map<number, PendingConversion>();
  let nextId = 0;
  let failed = false;
  let released = false;

  const failAllPending = () => {
    const stranded = [...pending.values()];
    pending.clear();
    for (const conversion of stranded) conversion.onConverted(null);
  };

  worker.onmessage = ({ data }: MessageEvent<ConverterWorkerMessage>) => {
    const conversion = pending.get(data.id);
    pending.delete(data.id);
    if (!conversion) {
      data.bitmap?.close();
      return;
    }
    conversion.onConverted(data.bitmap ? bitmapRingFrame(data.bitmap, conversion.timestamp) : null);
  };
  worker.onerror = event => {
    if (failed) return;
    failed = true;
    log.debug('dvr.frame_converter.failed', { detail: event.message });
    worker.terminate();
    failAllPending();
  };

  return {
    convert: (frame, onConverted) => {
      if (failed || released) {
        onConverted(frame);
        return;
      }
      const id = nextId++;
      pending.set(id, { timestamp: frame.timestamp, onConverted });
      try {
        worker.postMessage({ id, frame }, [frame as Transferable]);
      } catch (error) {
        pending.delete(id);
        log.debug('dvr.frame_converter.transfer_failed', { error });
        onConverted(frame);
      }
    },
    release: () => {
      if (released) return;
      released = true;
      worker.terminate();
      failAllPending();
    },
  };
}
