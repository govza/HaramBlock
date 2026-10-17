import { createWasmDecoder } from '@/utils/lookahead/wasmDecoder';
import { createWebCodecsDecoder, toModelInputBitmap } from '@/utils/lookahead/webCodecsDecoder';

import type { CapableDecoder, DecodedTarget, DecodeJob, DecoderPort } from '@/utils/lookahead/ports';

type DecoderChoiceListener = (codec: string, decoder: CapableDecoder['kind'] | null) => void;

/**
 * Routes each Decode Job to the first decoder that supports its config, in preference order, and
 * remembers the choice per codec string.
 */
export function createFirstSupportingDecoder(
  candidates: readonly CapableDecoder[],
  onChosen?: DecoderChoiceListener,
): DecoderPort {
  const choiceByCodec = new Map<string, Promise<CapableDecoder | null>>();

  const choose = (config: VideoDecoderConfig): Promise<CapableDecoder | null> => {
    const cached = choiceByCodec.get(config.codec);
    if (cached) return cached;
    const chosen = (async () => {
      for (const candidate of candidates) {
        if (await candidate.supports(config)) {
          onChosen?.(config.codec, candidate.kind);
          return candidate;
        }
      }
      onChosen?.(config.codec, null);
      return null;
    })();
    choiceByCodec.set(config.codec, chosen);
    return chosen;
  };

  return {
    async *decode(job: DecodeJob): AsyncIterable<DecodedTarget> {
      const decoder = await choose(job.config);
      if (!decoder) throw new Error(`Unsupported codec ${job.config.codec}`);
      yield* decoder.decode(job);
    },
  };
}

const wasmDecoderByInputSize = new Map<number, CapableDecoder>();

/**
 * The host's decoder for one analysis: native WebCodecs when it takes the job, otherwise the bundled
 * WASM decoders, whose single worker is shared by every analysis at the same model input size.
 */
export function lookaheadDecoder(
  inputSize: number,
  options: {
    hardwareAcceleration?: HardwareAcceleration;
    onChosen?: DecoderChoiceListener;
  } = {},
): DecoderPort {
  let wasm = wasmDecoderByInputSize.get(inputSize);
  if (!wasm) {
    wasm = createWasmDecoder(inputSize);
    wasmDecoderByInputSize.set(inputSize, wasm);
  }
  const native = createWebCodecsDecoder(frame => toModelInputBitmap(frame, inputSize), options.hardwareAcceleration);
  return createFirstSupportingDecoder([native, wasm], options.onChosen);
}
