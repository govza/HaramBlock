/**
 * Deterministic mock encoder/decoder pair for encoded-ring tests — no real
 * WebCodecs in vitest. Encoding emits one chunk per frame synchronously
 * (timestamp passthrough); decoding emits one frame per chunk synchronously.
 */

import type {
  DecodedRingFrame,
  DecoderCallbacks,
  EncodedRingCodecs,
  EncoderCallbacks,
  RingDecoder,
  RingEncoder,
} from '@/entrypoints/content/video/dvr/encodedFrameRing';
import type { DvrCaptureFrame } from '@/entrypoints/content/video/dvr/frameStore';

export const KEY_CHUNK_BYTES = 5000;
export const DELTA_CHUNK_BYTES = 1000;

export interface FakeVideoFrame {
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly timestamp: number;
  closed: boolean;
  close(): void;
}

export function fakeVideoFrame(mediaTime: number, width = 640, height = 360): FakeVideoFrame {
  const frame: FakeVideoFrame = {
    displayWidth: width,
    displayHeight: height,
    timestamp: Math.round(mediaTime * 1_000_000),
    closed: false,
    close: () => {
      frame.closed = true;
    },
  };
  return frame;
}

export function asCaptureFrame(frame: FakeVideoFrame): DvrCaptureFrame {
  return frame as unknown as DvrCaptureFrame;
}

export interface MockDecodedFrame extends DecodedRingFrame {
  closed: boolean;
}

export class MockEncoder implements RingEncoder {
  encodeQueueSize = 0;
  configureCalls = 0;
  resetCalls = 0;
  encodeCalls = 0;
  closed = false;
  config: VideoEncoderConfig | null = null;

  constructor(
    private readonly callbacks: EncoderCallbacks,
    private readonly failAtEncodeCall?: number,
  ) {}

  configure(config: VideoEncoderConfig): void {
    this.configureCalls++;
    this.config = config;
  }

  encode(frame: VideoFrame, options?: { keyFrame?: boolean }): void {
    this.encodeCalls++;
    if (this.failAtEncodeCall !== undefined && this.encodeCalls >= this.failAtEncodeCall) {
      this.callbacks.error(new Error('mock encode failure'));
      return;
    }
    const key = options?.keyFrame === true;
    this.callbacks.output(
      {
        type: key ? 'key' : 'delta',
        timestamp: (frame as unknown as FakeVideoFrame).timestamp,
        byteLength: key ? KEY_CHUNK_BYTES : DELTA_CHUNK_BYTES,
      },
      key && this.config ? { decoderConfig: { codec: this.config.codec } } : undefined,
    );
  }

  reset(): void {
    this.resetCalls++;
    this.config = null;
  }

  close(): void {
    this.closed = true;
  }
}

export class MockDecoder implements RingDecoder {
  decodeQueueSize = 0;
  configureCalls = 0;
  lastConfig: VideoDecoderConfig | null = null;
  resetCalls = 0;
  decodeCalls = 0;
  closed = false;
  readonly frames: MockDecodedFrame[] = [];

  constructor(
    private readonly callbacks: DecoderCallbacks,
    private readonly failAtDecodeCall?: number,
  ) {}

  configure(config: VideoDecoderConfig): void {
    this.configureCalls++;
    this.lastConfig = config;
  }

  decode(chunk: { timestamp: number }): void {
    this.decodeCalls++;
    if (this.failAtDecodeCall !== undefined && this.decodeCalls >= this.failAtDecodeCall) {
      this.callbacks.error(new Error('mock decode failure'));
      return;
    }
    const frame: MockDecodedFrame = {
      displayWidth: 640,
      displayHeight: 360,
      timestamp: chunk.timestamp,
      closed: false,
      close: () => {
        frame.closed = true;
      },
    };
    this.frames.push(frame);
    this.callbacks.output(frame);
  }

  reset(): void {
    this.resetCalls++;
  }

  close(): void {
    this.closed = true;
  }
}

export interface MockCodecOptions {
  failAtEncodeCall?: number;
  failAtDecodeCall?: number;
}

export interface MockCodecPair extends EncodedRingCodecs {
  readonly encoders: MockEncoder[];
  readonly decoders: MockDecoder[];
}

export function createMockCodecs(options: MockCodecOptions = {}): MockCodecPair {
  const encoders: MockEncoder[] = [];
  const decoders: MockDecoder[] = [];
  return {
    encoders,
    decoders,
    createEncoder: callbacks => {
      const encoder = new MockEncoder(callbacks, options.failAtEncodeCall);
      encoders.push(encoder);
      return encoder;
    },
    createDecoder: callbacks => {
      const decoder = new MockDecoder(callbacks, options.failAtDecodeCall);
      decoders.push(decoder);
      return decoder;
    },
  };
}
