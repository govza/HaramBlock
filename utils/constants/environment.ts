export const IS_CHROME = import.meta.env.CHROME === true;

export const USE_MESSAGE_CHANNEL = IS_CHROME;

export type ImageTransferKind = 'bitmap' | 'blob' | 'url';

export type VideoFrameTransferKind = 'bitmap' | 'blob';

export const IMAGE_TRANSFER_KIND: ImageTransferKind = IS_CHROME ? 'bitmap' : 'blob';
