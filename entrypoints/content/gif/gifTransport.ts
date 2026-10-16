import {
  fetchMediaBlob,
  requestGifFrameInference,
  type GifFrameParams,
} from '@/entrypoints/content/communication/sender';
import { decodeGifFrames, type DecodedGif } from '@/entrypoints/content/gif/gifDecoder';
import { IS_CHROME } from '@/utils/constants/environment';
import { waitForMessageChannel } from '@/utils/messaging/content';

/**
 * The I/O a GIF inspection depends on: whether frames can be transferred at all, fetching and decoding
 * the GIF, and sending one sampled frame for inference. `sendFrame` receives a playback bitmap the
 * inspector keeps drawing, so it must not take ownership of it.
 */
export interface GifTransport {
  channelReady(): Promise<boolean>;
  decode(src: string): Promise<DecodedGif | null>;
  sendFrame(params: GifFrameParams): Promise<void>;
}

/**
 * GIF frames are transferred like video frames (no URL fallback); on Chrome that needs the
 * MessageChannel.
 */
const channelReady = async (): Promise<boolean> => !IS_CHROME || waitForMessageChannel();

const decode = async (src: string): Promise<DecodedGif | null> => decodeGifFrames(await fetchMediaBlob(src));

const sendFrame = async (params: GifFrameParams): Promise<void> =>
  requestGifFrameInference({ ...params, bitmap: await createImageBitmap(params.bitmap) });

export const gifTransport: GifTransport = { channelReady, decode, sendFrame };
