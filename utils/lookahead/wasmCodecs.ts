export type WasmCodec = 'vp9' | 'av1';

/**
 * One Emscripten-built decoder instance, exposing the C interface every codec shim in
 * `scripts/wasm-decoders/` implements.
 */
export interface WasmDecoderModule {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _dec_open(extradataPointer: number, extradataLength: number): number;
  _dec_close(): void;
  _dec_reset(): void;
  _dec_send(dataPointer: number, length: number, ptsUs: number): number;
  _dec_drain(): number;
  _dec_receive(): number;
  _dec_width(): number;
  _dec_height(): number;
  _dec_plane(index: number): number;
  _dec_stride(index: number): number;
  _dec_pts(): number;
  _dec_format(): number;
}

export type WasmDecoderFactory = (options?: {
  locateFile?: (path: string, prefix: string) => string;
}) => Promise<WasmDecoderModule>;

export const WASM_DECODER_DIR = 'wasm-decoders';

export const WASM_PIXEL_FORMAT_I420 = 0;

export const WASM_FACTORY_NAMES: Record<WasmCodec, string> = {
  vp9: 'createVp9Decoder',
  av1: 'createAv1Decoder',
};

export function wasmCodecOf(codec: string): WasmCodec | null {
  const family = codec.split('.')[0]?.toLowerCase();
  if (family === 'vp09' || family === 'vp9') return 'vp9';
  if (family === 'av01') return 'av1';
  return null;
}
