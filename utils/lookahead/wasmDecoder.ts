import { fanOutToTargets, groupTargetsByPts } from '@/utils/lookahead/targetFanOut';
import { wasmCodecOf } from '@/utils/lookahead/wasmCodecs';
import { WASM_DECODER_WORKER_PATH, type FromWasmWorker, type ToWasmWorker } from '@/utils/lookahead/wasmWorkerProtocol';

import type { CapableDecoder, DecodedTarget, DecodeJob } from '@/utils/lookahead/ports';
import type { BitmapFrame } from '@/utils/lookahead/webCodecsDecoder';

/**
 * Where a job's frames arrive while the worker decodes it.
 */
interface JobChannel {
  push(message: FromWasmWorker): void;
}

const descriptionBytes = (config: VideoDecoderConfig): Uint8Array | null => {
  const { description } = config;
  if (!description) return null;
  if (ArrayBuffer.isView(description)) {
    return new Uint8Array(
      description.buffer.slice(description.byteOffset, description.byteOffset + description.byteLength),
    );
  }
  return new Uint8Array(description.slice(0));
};

function frameStream(): { channel: JobChannel; messages: AsyncIterable<FromWasmWorker> } {
  const buffered: FromWasmWorker[] = [];
  let wake: (() => void) | null = null;
  const channel: JobChannel = {
    push: message => {
      buffered.push(message);
      wake?.();
      wake = null;
    },
  };
  const messages = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = buffered.shift();
        if (next) {
          yield next;
          if (next.t !== 'frame') return;
          continue;
        }
        await new Promise<void>(resolve => {
          wake = resolve;
        });
      }
    },
  };
  return { channel, messages };
}

/**
 * Decodes VP9 and AV1 Decode Jobs with the bundled WebAssembly decoders in one dedicated
 * worker, converting target frames to model-input bitmaps there.
 */
export function createWasmDecoder(inputSize: number): CapableDecoder {
  let worker: Worker | null = null;
  let nextJobId = 1;
  const channels = new Map<number, JobChannel>();

  const workerInstance = (): Worker => {
    if (worker) return worker;
    worker = new Worker(WASM_DECODER_WORKER_PATH);
    worker.addEventListener('message', (event: MessageEvent<FromWasmWorker>) => {
      const channel = channels.get(event.data.jobId);
      if (channel) channel.push(event.data);
      else if (event.data.t === 'frame') event.data.bitmap.close();
    });
    worker.addEventListener('error', event => {
      for (const [jobId, channel] of channels) channel.push({ t: 'error', jobId, message: event.message });
    });
    return worker;
  };

  return {
    kind: 'wasm',
    supports: config => Promise.resolve(wasmCodecOf(config.codec) !== null),

    async *decode(job: DecodeJob): AsyncIterable<DecodedTarget> {
      const codec = wasmCodecOf(job.config.codec);
      if (!codec) throw new Error(`Unsupported codec ${job.config.codec}`);
      const jobId = nextJobId++;
      const { channel, messages } = frameStream();
      channels.set(jobId, channel);
      const targetsByPts = groupTargetsByPts(job.targets);
      const message: ToWasmWorker = {
        t: 'decode',
        jobId,
        codec,
        run: {
          extradata: descriptionBytes(job.config),
          packets: job.packets.map(packet => ({ data: packet.data, timestampUs: packet.timestampUs })),
          targetPtsUs: [...targetsByPts.keys()],
          inputSize,
        },
      };
      workerInstance().postMessage(message);
      try {
        for await (const received of messages) {
          if (received.t === 'error') throw new Error(received.message);
          if (received.t === 'done') return;
          const frame: BitmapFrame = {
            bitmap: received.bitmap,
            originalWidth: received.originalWidth,
            originalHeight: received.originalHeight,
            close: () => received.bitmap.close(),
          };
          yield* fanOutToTargets(frame, targetsByPts.get(received.ptsUs) ?? []);
        }
      } finally {
        channels.delete(jobId);
      }
    },
  };
}
