import { WASM_PIXEL_FORMAT_I420, type WasmDecoderModule } from '@/utils/lookahead/wasmCodecs';
import { i420ToRgba, type RgbaImage } from '@/utils/lookahead/yuvToRgba';

/**
 * A decodable run of packets for a WASM decoder: a Decode Job reduced to bytes and the target PTS set.
 */
export interface WasmDecodeRun {
  extradata: Uint8Array | null;
  packets: readonly { data: Uint8Array; timestampUs: number }[];
  targetPtsUs: readonly number[];
  inputSize: number;
}

/**
 * A target frame decoded and converted to model input, with the source dimensions for mask mapping.
 */
export interface WasmDecodedFrame {
  ptsUs: number;
  image: RgbaImage;
  originalWidth: number;
  originalHeight: number;
}

/**
 * Owns one WASM decoder instance across runs: opens it lazily with the run's extradata, resets it
 * between runs, and reopens it when the extradata changes.
 */
export class WasmDecodeSession {
  private openedWith: string | null = null;

  constructor(private readonly module: WasmDecoderModule) {}

  decode(run: WasmDecodeRun, onFrame: (frame: WasmDecodedFrame) => void): void {
    this.prepare(run.extradata);
    const pending = new Set(run.targetPtsUs);
    for (const packet of run.packets) {
      this.send(packet.data, packet.timestampUs);
      this.receiveAll(pending, run.inputSize, onFrame);
      if (pending.size === 0) return;
    }
    this.check(this.module._dec_drain(), 'drain');
    this.receiveAll(pending, run.inputSize, onFrame);
  }

  close(): void {
    if (this.openedWith !== null) this.module._dec_close();
    this.openedWith = null;
  }

  private prepare(extradata: Uint8Array | null): void {
    const key = extradata ? extradata.join(',') : '';
    if (this.openedWith === key) {
      this.module._dec_reset();
      return;
    }
    this.close();
    const length = extradata?.length ?? 0;
    const pointer = length > 0 ? this.module._malloc(length) : 0;
    if (extradata && pointer) this.module.HEAPU8.set(extradata, pointer);
    const status = this.module._dec_open(pointer, length);
    if (pointer) this.module._free(pointer);
    this.check(status, 'open');
    this.openedWith = key;
  }

  private send(data: Uint8Array, ptsUs: number): void {
    const pointer = this.module._malloc(data.length);
    this.module.HEAPU8.set(data, pointer);
    this.check(this.module._dec_send(pointer, data.length, ptsUs), 'send');
  }

  private receiveAll(pending: Set<number>, inputSize: number, onFrame: (frame: WasmDecodedFrame) => void): void {
    for (;;) {
      const status = this.module._dec_receive();
      this.check(status, 'receive');
      if (status === 0) return;
      const ptsUs = this.module._dec_pts();
      if (!pending.delete(ptsUs)) continue;
      if (this.module._dec_format() !== WASM_PIXEL_FORMAT_I420) throw new Error('Unsupported pixel format');
      const originalWidth = this.module._dec_width();
      const originalHeight = this.module._dec_height();
      const image = i420ToRgba(
        {
          heap: this.module.HEAPU8,
          width: originalWidth,
          height: originalHeight,
          planes: [this.module._dec_plane(0), this.module._dec_plane(1), this.module._dec_plane(2)],
          strides: [this.module._dec_stride(0), this.module._dec_stride(1), this.module._dec_stride(2)],
        },
        inputSize,
      );
      onFrame({ ptsUs, image, originalWidth, originalHeight });
    }
  }

  private check(status: number, step: string): void {
    if (status < 0) {
      this.close();
      throw new Error(`WASM decoder ${step} failed (${status})`);
    }
  }
}
