import { encodeMaskRLE } from '@/utils/rle';

import type { IElementPrediction, IScoreGrid } from '@/utils/types';

export interface GridGeometry {
  width: number;
  height: number;
  cellWidth: number;
  cellHeight: number;
}

interface ClassCells {
  mask: Uint8Array;
  confidenceSum: number;
  count: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const QUANTIZATION_LEVELS = 255;

export const quantizeProbability = (probability: number): number =>
  Math.min(QUANTIZATION_LEVELS, Math.max(0, Math.round(probability * QUANTIZATION_LEVELS)));

const dequantizeProbability = (value: number): number => value / QUANTIZATION_LEVELS;

export class SemanticCells {
  private readonly byClass = new Map<number, ClassCells>();

  constructor(
    private readonly geometry: GridGeometry,
    private readonly classNameOf: (classId: number) => string,
  ) {}

  add(cellIndex: number, classId: number, probability: number): void {
    const { width, height } = this.geometry;
    let cells = this.byClass.get(classId);
    if (!cells) {
      cells = {
        mask: new Uint8Array(width * height),
        confidenceSum: 0,
        count: 0,
        minX: width,
        minY: height,
        maxX: 0,
        maxY: 0,
      };
      this.byClass.set(classId, cells);
    }
    const x = cellIndex % width;
    const y = Math.floor(cellIndex / width);
    cells.mask[cellIndex] = 1;
    cells.confidenceSum += probability;
    cells.count++;
    cells.minX = Math.min(cells.minX, x);
    cells.minY = Math.min(cells.minY, y);
    cells.maxX = Math.max(cells.maxX, x);
    cells.maxY = Math.max(cells.maxY, y);
  }

  predictions(classOrder: Iterable<number>): IElementPrediction[] {
    const { width, height, cellWidth, cellHeight } = this.geometry;
    const predictions: IElementPrediction[] = [];
    for (const classId of classOrder) {
      const cells = this.byClass.get(classId);
      if (!cells || cells.count === 0) continue;
      const boxX1 = cells.minX * cellWidth;
      const boxY1 = cells.minY * cellHeight;
      const boxX2 = (cells.maxX + 1) * cellWidth;
      const boxY2 = (cells.maxY + 1) * cellHeight;
      predictions.push({
        classId,
        className: this.classNameOf(classId),
        probability: cells.confidenceSum / cells.count,
        boundingBox: {
          x: Math.floor(boxX1),
          y: Math.floor(boxY1),
          width: Math.round(boxX2 - boxX1),
          height: Math.round(boxY2 - boxY1),
        },
        masks: encodeMaskRLE(cells.mask, width, height),
      });
    }
    return predictions;
  }
}

function encodeValueRuns(values: Uint8Array): number[] {
  const runs: number[] = [];
  let index = 0;
  while (index < values.length) {
    const value = values[index] ?? 0;
    let end = index + 1;
    while (end < values.length && values[end] === value) end++;
    runs.push(value, end - index);
    index = end;
  }
  return runs;
}

function decodeValueRuns(runs: readonly number[], size: number): Uint8Array {
  const values = new Uint8Array(size);
  let offset = 0;
  for (let index = 0; index + 1 < runs.length; index += 2) {
    const length = Math.min(runs[index + 1] ?? 0, size - offset);
    values.fill(runs[index] ?? 0, offset, offset + length);
    offset += length;
  }
  return values;
}

export function encodeScoreGrid(
  geometry: GridGeometry,
  quantizedProbabilities: Uint8Array,
  classIds: Uint8Array,
  classNames: Record<number, string>,
): IScoreGrid {
  return {
    ...geometry,
    probabilityRuns: encodeValueRuns(quantizedProbabilities),
    classIdRuns: encodeValueRuns(classIds),
    classNames,
  };
}

export function predictionsFromScoreGrid(grid: IScoreGrid, scoreThreshold: number): IElementPrediction[] {
  const size = grid.width * grid.height;
  const probabilities = decodeValueRuns(grid.probabilityRuns, size);
  const classIds = decodeValueRuns(grid.classIdRuns, size);
  const cells = new SemanticCells(grid, classId => grid.classNames[classId] ?? `class_${classId}`);
  for (let cellIndex = 0; cellIndex < size; cellIndex++) {
    const value = probabilities[cellIndex] ?? 0;
    if (value === 0) continue;
    const probability = dequantizeProbability(value);
    if (probability >= scoreThreshold) cells.add(cellIndex, classIds[cellIndex] ?? 0, probability);
  }
  const classOrder = Object.keys(grid.classNames)
    .map(Number)
    .sort((a, b) => a - b);
  return cells.predictions(classOrder);
}
