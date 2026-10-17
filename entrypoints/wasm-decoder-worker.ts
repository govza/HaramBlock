import {
  WASM_DECODER_DIR,
  WASM_FACTORY_NAMES,
  type WasmCodec,
  type WasmDecoderFactory,
} from '@/utils/lookahead/wasmCodecs';
import { WasmDecodeSession } from '@/utils/lookahead/wasmDecodeCore';

import type { FromWasmWorker, ToWasmWorker } from '@/utils/lookahead/wasmWorkerProtocol';

/**
 * The slice of the dedicated worker global scope this worker uses.
 */
interface DecoderWorkerScope {
  importScripts(...urls: string[]): void;
  postMessage(message: FromWasmWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<ToWasmWorker>) => void): void;
}

export default defineUnlistedScript(() => {
  const scope = globalThis as unknown as DecoderWorkerScope;
  const sessions = new Map<WasmCodec, Promise<WasmDecodeSession>>();

  const sessionFor = (codec: WasmCodec): Promise<WasmDecodeSession> => {
    const existing = sessions.get(codec);
    if (existing) return existing;
    const created = (async () => {
      scope.importScripts(`/${WASM_DECODER_DIR}/${codec}.js`);
      const factory = (globalThis as unknown as Record<string, WasmDecoderFactory>)[WASM_FACTORY_NAMES[codec]];
      if (!factory) throw new Error(`Missing WASM decoder factory for ${codec}`);
      return new WasmDecodeSession(await factory({ locateFile: path => `/${WASM_DECODER_DIR}/${path}` }));
    })();
    created.catch(() => sessions.delete(codec));
    sessions.set(codec, created);
    return created;
  };

  let queue = Promise.resolve();

  const decode = async ({ jobId, codec, run }: ToWasmWorker): Promise<void> => {
    try {
      const session = await sessionFor(codec);
      const conversions: Promise<void>[] = [];
      session.decode(run, ({ ptsUs, image, originalWidth, originalHeight }) => {
        conversions.push(
          createImageBitmap(new ImageData(image.data, image.width, image.height)).then(bitmap =>
            scope.postMessage({ t: 'frame', jobId, ptsUs, bitmap, originalWidth, originalHeight }, [bitmap]),
          ),
        );
      });
      await Promise.all(conversions);
      scope.postMessage({ t: 'done', jobId });
    } catch (error) {
      scope.postMessage({ t: 'error', jobId, message: error instanceof Error ? error.message : String(error) });
    }
  };

  scope.addEventListener('message', event => {
    queue = queue.then(() => decode(event.data));
  });
});
