import type { WasmCodec } from '@/utils/lookahead/wasmCodecs';
import type { WasmDecodeRun } from '@/utils/lookahead/wasmDecodeCore';

export const WASM_DECODER_WORKER_PATH = '/wasm-decoder-worker.js';

export type ToWasmWorker = { t: 'decode'; jobId: number; codec: WasmCodec; run: WasmDecodeRun };

export type FromWasmWorker =
  | { t: 'frame'; jobId: number; ptsUs: number; bitmap: ImageBitmap; originalWidth: number; originalHeight: number }
  | { t: 'done'; jobId: number }
  | { t: 'error'; jobId: number; message: string };
