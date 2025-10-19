// #region IMAGE TYPES
export type IImageMetadata = {
  contentType: string | null;
  contentLength: number | null;
  lastModified: string | null;
  cacheControl: string | null;
  etag: string | null;
  expires: string | null;
};

// --- Shared field groups ---
type MediaBase = {
  src: string;
  width: number;
  height: number;
  metadata: IImageMetadata;
};

type TransferFields = {
  hostname: string;
  tabId: number;
  bitmap: ImageBitmap;
};

// --- Image types (discriminated union) ---
export type IImageWithMetadata = {
  media: 'image';
  transport: 'serializable';
} & MediaBase;

export type IImageWithBitmap = {
  media: 'image';
  transport: 'transferable';
} & MediaBase &
  TransferFields;

