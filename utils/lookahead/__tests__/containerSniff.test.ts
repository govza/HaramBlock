import { describe, expect, it } from 'vitest';

import { EBML_MAGIC, initPieceKindOf, initSegmentLength, WEBM_CLUSTER_MAGIC } from '@/utils/lookahead/containerSniff';

const box = (type: string, payloadLength = 0): number[] => {
  const size = 8 + payloadLength;
  return [
    (size >>> 24) & 0xff,
    (size >>> 16) & 0xff,
    (size >>> 8) & 0xff,
    size & 0xff,
    ...Array.from(type, char => char.charCodeAt(0)),
    ...new Array<number>(payloadLength).fill(0),
  ];
};

const bufferOf = (bytes: number[]): ArrayBuffer => new Uint8Array(bytes).buffer;

describe('initPieceKindOf', () => {
  it('recognizes a WebM EBML header', () => {
    expect(initPieceKindOf(bufferOf([...EBML_MAGIC, 0x9f]))).toBe('webm');
  });

  it('recognizes ftyp and moov boxes', () => {
    expect(initPieceKindOf(bufferOf(box('ftyp', 4)))).toBe('ftyp');
    expect(initPieceKindOf(bufferOf(box('moov')))).toBe('moov');
  });

  it('rejects media boxes and short or unknown bytes', () => {
    expect(initPieceKindOf(bufferOf(box('moof')))).toBeNull();
    expect(initPieceKindOf(bufferOf([0x00, 0x01]))).toBeNull();
    expect(initPieceKindOf(new ArrayBuffer(0))).toBeNull();
  });
});

describe('initSegmentLength', () => {
  it('ends a WebM init at the first Cluster', () => {
    const bytes = [...EBML_MAGIC, 0x81, 0x00, 0x42, ...WEBM_CLUSTER_MAGIC, 0x80];
    expect(initSegmentLength(bufferOf(bytes), 'webm')).toBe(7);
  });

  it('spans the whole WebM append when it has no Cluster', () => {
    expect(initSegmentLength(bufferOf([...EBML_MAGIC, 0x80]), 'webm')).toBe(5);
  });

  it('ends an MP4 init at the first media box', () => {
    const bytes = [...box('ftyp', 4), ...box('moov', 8), ...box('moof', 2), ...box('mdat', 2)];
    expect(initSegmentLength(bufferOf(bytes), 'ftyp')).toBe(28);
  });

  it('spans the whole MP4 append when it has no media box', () => {
    const bytes = [...box('moov', 8)];
    expect(initSegmentLength(bufferOf(bytes), 'moov')).toBe(16);
  });

  it('gives up on a malformed box size', () => {
    const bytes = [0, 0, 0, 4, ...Array.from('moov', char => char.charCodeAt(0)), ...box('moof')];
    expect(initSegmentLength(bufferOf(bytes), 'moov')).toBe(bytes.length);
  });
});
