export const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3] as const;
export const WEBM_CLUSTER_MAGIC = [0x1f, 0x43, 0xb6, 0x75] as const;
export const MP4_INIT_BOXES: ReadonlySet<string> = new Set(['ftyp', 'moov']);

const MP4_MEDIA_BOXES: ReadonlySet<string> = new Set(['moof', 'mdat', 'sidx', 'styp', 'emsg', 'prft']);

export type InitPieceKind = 'webm' | 'ftyp' | 'moov';

const startsWithAt = (bytes: Uint8Array, offset: number, magic: readonly number[]): boolean =>
  magic.every((byte, index) => bytes[offset + index] === byte);

export const initPieceKindOf = (bytes: ArrayBuffer): InitPieceKind | null => {
  const head = new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength));
  if (startsWithAt(head, 0, EBML_MAGIC)) return 'webm';
  if (head.length < 8) return null;
  const boxType = String.fromCharCode(...head.subarray(4, 8));
  if (boxType === 'ftyp' || boxType === 'moov') return boxType;
  return null;
};

const webmInitLength = (view: Uint8Array): number => {
  for (let offset = 0; offset + WEBM_CLUSTER_MAGIC.length <= view.length; offset++) {
    if (startsWithAt(view, offset, WEBM_CLUSTER_MAGIC)) return offset;
  }
  return view.length;
};

const mp4BoxSize = (data: DataView, offset: number): number => {
  const size = data.getUint32(offset);
  if (size === 0) return data.byteLength - offset;
  if (size === 1 && offset + 16 <= data.byteLength) return Number(data.getBigUint64(offset + 8));
  return size;
};

const mp4InitLength = (bytes: ArrayBuffer): number => {
  const data = new DataView(bytes);
  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    const boxType = String.fromCharCode(...new Uint8Array(bytes, offset + 4, 4));
    if (MP4_MEDIA_BOXES.has(boxType)) return offset;
    const size = mp4BoxSize(data, offset);
    if (size < 8) return bytes.byteLength;
    offset += size;
  }
  return bytes.byteLength;
};

export const initSegmentLength = (bytes: ArrayBuffer, kind: InitPieceKind): number =>
  kind === 'webm' ? webmInitLength(new Uint8Array(bytes)) : mp4InitLength(bytes);
