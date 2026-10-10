export type ContainerKind = 'webm' | 'mp4';

export interface InitSegment {
  readonly generation: number;
  readonly bytes: Uint8Array;
}

export interface AnalysisUnitBytes {
  readonly init: InitSegment;
  readonly bytes: Uint8Array;
}

export interface CutResult {
  inits: InitSegment[];
  units: AnalysisUnitBytes[];
}

const EBML_HEADER_ID = 0x1a45dfa3;
const SEGMENT_ID = 0x18538067;
const CLUSTER_ID = 0x1f43b675;
const WEBM_LEVEL1_IDS = new Set([
  0x114d9b74,
  0x1549a966,
  0x1654ae6b,
  0x1c53bb6b,
  CLUSTER_ID,
  0x1941a469,
  0x1043a770,
  0x1254c367,
]);

const MP4_INIT_BOXES = new Set(['ftyp', 'moov']);

export function containerKindOf(mime: string): ContainerKind | null {
  const type = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type.endsWith('/webm')) return 'webm';
  if (type.endsWith('/mp4')) return 'mp4';
  return null;
}

class GrowableBytes {
  private buffer = new Uint8Array(0);
  private length = 0;

  get size(): number {
    return this.length;
  }

  push(chunk: Uint8Array): void {
    if (this.length + chunk.length > this.buffer.length) {
      const grown = new Uint8Array(Math.max(this.buffer.length * 2, this.length + chunk.length));
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    this.buffer.set(chunk, this.length);
    this.length += chunk.length;
  }

  view(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }

  clear(): void {
    this.length = 0;
  }

  take(count: number): Uint8Array {
    const taken = this.buffer.slice(0, count);
    this.buffer.copyWithin(0, count, this.length);
    this.length -= count;
    return taken;
  }
}

interface VintRead {
  value: number;
  length: number;
  unknown: boolean;
}

function readVint(bytes: Uint8Array, offset: number, keepMarker: boolean): VintRead | null {
  const first = bytes[offset];
  if (first === undefined) return null;
  let length = 1;
  while (length <= 8 && (first & (0x80 >> (length - 1))) === 0) length++;
  if (length > 8 || offset + length > bytes.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const byte = bytes[offset + i] ?? 0;
    value = value * 256 + byte;
    allOnes &&= byte === 0xff;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

interface ElementHeader {
  id: number;
  headerLength: number;
  size: number | null;
}

function readElementHeader(bytes: Uint8Array, offset: number): ElementHeader | null {
  const id = readVint(bytes, offset, true);
  if (!id) return null;
  const size = readVint(bytes, offset + id.length, false);
  if (!size) return null;
  return { id: id.value, headerLength: id.length + size.length, size: size.unknown ? null : size.value };
}

type WebmState = 'top' | 'segment';

function indexOfMarker(bytes: Uint8Array, markers: readonly (readonly number[])[], from = 0): number {
  for (let index = from; index < bytes.length; index++) {
    if (markers.some(marker => marker.every((byte, offset) => bytes[index + offset] === byte))) return index;
  }
  return -1;
}

const WEBM_RESYNC_MARKERS = [
  [0x1f, 0x43, 0xb6, 0x75],
  [0x1a, 0x45, 0xdf, 0xa3],
];
const MP4_RESYNC_MARKERS = [
  [0x6d, 0x6f, 0x6f, 0x66],
  [0x66, 0x74, 0x79, 0x70],
];
const MP4_SIZE_FIELD_BYTES = 4;

class WebmCutter {
  private readonly pending = new GrowableBytes();
  private initParts: Uint8Array[] = [];
  private init: InitSegment | null = null;
  private generation = 0;
  private state: WebmState = 'top';
  private segmentEnd: number | null = null;
  private consumed = 0;
  private resyncing = false;

  resync(): void {
    this.pending.clear();
    this.resyncing = true;
  }

  push(chunk: Uint8Array): CutResult {
    this.pending.push(chunk);
    const result: CutResult = { inits: [], units: [] };
    if (this.resyncing && !this.skipToUnitStart()) return result;
    while (this.step(result));
    return result;
  }

  private skipToUnitStart(): boolean {
    const bytes = this.pending.view();
    const start = indexOfMarker(bytes, WEBM_RESYNC_MARKERS);
    if (start < 0) {
      this.pending.take(Math.max(0, bytes.length - 3));
      return false;
    }
    this.pending.take(start);
    this.resyncing = false;
    this.state = 'segment';
    this.segmentEnd = null;
    return true;
  }

  private step(result: CutResult): boolean {
    const bytes = this.pending.view();
    const header = readElementHeader(bytes, 0);
    if (!header) return false;
    if (this.state === 'segment' && this.segmentEnd !== null && this.consumed >= this.segmentEnd) {
      this.state = 'top';
    }
    if (header.id === EBML_HEADER_ID) {
      if (header.size === null || bytes.length < header.headerLength + header.size) return false;
      this.initParts = [this.consume(header.headerLength + header.size)];
      this.state = 'top';
      return true;
    }
    if (header.id === SEGMENT_ID) {
      this.initParts.push(this.consume(header.headerLength));
      this.state = 'segment';
      this.segmentEnd = header.size === null ? null : this.consumed + header.size;
      return true;
    }
    if (this.state !== 'segment') {
      if (header.size === null || bytes.length < header.headerLength + header.size) return false;
      this.consume(header.headerLength + header.size);
      return true;
    }
    if (header.id === CLUSTER_ID) return this.cutCluster(header, result);
    if (header.size === null || bytes.length < header.headerLength + header.size) return false;
    const element = this.consume(header.headerLength + header.size);
    if (this.isInitElement(header.id)) {
      this.initParts.push(element);
      this.sealInitIfComplete(header.id, result);
    }
    return true;
  }

  private isInitElement(id: number): boolean {
    return id === 0x1549a966 || id === 0x1654ae6b || id === 0x114d9b74;
  }

  private sealInitIfComplete(id: number, result: CutResult): void {
    if (id !== 0x1654ae6b) return;
    this.generation += 1;
    this.init = { generation: this.generation, bytes: concat(this.initParts) };
    result.inits.push(this.init);
  }

  private cutCluster(header: ElementHeader, result: CutResult): boolean {
    const bytes = this.pending.view();
    let end: number | null = null;
    if (header.size !== null) {
      end = header.headerLength + header.size;
      if (bytes.length < end) return false;
    } else {
      let offset = header.headerLength;
      for (;;) {
        const child = readElementHeader(bytes, offset);
        if (!child) return false;
        if (WEBM_LEVEL1_IDS.has(child.id) || child.id === EBML_HEADER_ID) {
          end = offset;
          break;
        }
        if (child.size === null) return false;
        offset += child.headerLength + child.size;
        if (offset > bytes.length) return false;
        if (this.segmentEnd !== null && this.consumed + offset >= this.segmentEnd) {
          end = offset;
          break;
        }
      }
    }
    const unit = this.consume(end);
    if (this.init) result.units.push({ init: this.init, bytes: unit });
    return true;
  }

  private consume(count: number): Uint8Array {
    this.consumed += count;
    return this.pending.take(count);
  }
}

class Mp4Cutter {
  private readonly pending = new GrowableBytes();
  private initParts: Uint8Array[] = [];
  private init: InitSegment | null = null;
  private generation = 0;
  private fragment: Uint8Array[] = [];
  private resyncing = false;

  resync(): void {
    this.pending.clear();
    this.fragment = [];
    this.resyncing = true;
  }

  private skipToUnitStart(): boolean {
    const bytes = this.pending.view();
    const marker = indexOfMarker(bytes, MP4_RESYNC_MARKERS, MP4_SIZE_FIELD_BYTES);
    if (marker < 0) {
      this.pending.take(Math.max(0, bytes.length - MP4_SIZE_FIELD_BYTES - 3));
      return false;
    }
    this.pending.take(marker - MP4_SIZE_FIELD_BYTES);
    this.resyncing = false;
    return true;
  }

  push(chunk: Uint8Array): CutResult {
    this.pending.push(chunk);
    const result: CutResult = { inits: [], units: [] };
    if (this.resyncing && !this.skipToUnitStart()) return result;
    for (;;) {
      const box = this.nextBox();
      if (!box) break;
      this.accept(box.type, this.pending.take(box.size), result);
    }
    return result;
  }

  private nextBox(): { type: string; size: number } | null {
    const bytes = this.pending.view();
    if (bytes.length < 8) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let size = view.getUint32(0);
    const type = String.fromCharCode(bytes[4] ?? 0, bytes[5] ?? 0, bytes[6] ?? 0, bytes[7] ?? 0);
    if (size === 1) {
      if (bytes.length < 16) return null;
      size = Number(view.getBigUint64(8));
    } else if (size === 0) {
      return null;
    }
    if (size < 8 || bytes.length < size) return null;
    return { type, size };
  }

  private accept(type: string, box: Uint8Array, result: CutResult): void {
    if (MP4_INIT_BOXES.has(type)) {
      if (type === 'ftyp') this.initParts = [];
      this.initParts.push(box);
      if (type === 'moov') {
        this.generation += 1;
        this.init = { generation: this.generation, bytes: concat(this.initParts) };
        result.inits.push(this.init);
      }
      return;
    }
    if (type === 'moof') {
      this.fragment = [box];
      return;
    }
    if (type === 'mdat' && this.fragment.length > 0) {
      this.fragment.push(box);
      if (this.init) result.units.push({ init: this.init, bytes: concat(this.fragment) });
      this.fragment = [];
    }
  }
}

export interface UnitCutter {
  push(chunk: Uint8Array): CutResult;
  resync(): void;
}

export function createUnitCutter(kind: ContainerKind): UnitCutter {
  return kind === 'webm' ? new WebmCutter() : new Mp4Cutter();
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}
