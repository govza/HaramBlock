import { describe, expect, it } from 'vitest';

import { processInstanceSegmentation } from '@/utils/inference/runtimes/onnx/postprocessors/instance';

import type { PostprocessContext, TypedResults } from '@/utils/inference/runtimes/onnx/postprocessors/types';
import type { ModelMetadata } from '@/utils/types';

const NUM_FEATURES = 38; // x1, y1, x2, y2, conf, cls + 32 mask coefficients
const PROTO = 40; // prototype grid is 40x40 for a 160px model (stride 4)

function makeConfig(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    names: { 0: 'person', 1: 'cat' },
    imgsz: [160, 160],
    normalize: null,
    namesToCheck: ['person'],
    outputShape: [PROTO, PROTO],
    inputName: 'images',
    outputNames: { detections: 'output0', masks: 'output1' },
    stride: 32,
    task: 'segment',
    dynamicBatch: false,
    ...overrides,
  };
}

interface DetSpec {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  conf: number;
  cls: number;
  coeffs?: number[]; // mask coefficients, index 0..31
}

function det(spec: DetSpec): number[] {
  const arr = new Array<number>(NUM_FEATURES).fill(0);
  arr[0] = spec.x1;
  arr[1] = spec.y1;
  arr[2] = spec.x2;
  arr[3] = spec.y2;
  arr[4] = spec.conf;
  arr[5] = spec.cls;
  spec.coeffs?.forEach((v, c) => {
    arr[6 + c] = v;
  });
  return arr;
}

function detectionsTensor(dets: number[][]): TypedResults[string] {
  const data = new Float32Array(dets.length * NUM_FEATURES);
  dets.forEach((d, i) => data.set(d, i * NUM_FEATURES));
  return { data, dims: [1, dets.length, NUM_FEATURES] };
}

/** Prototype tensor whose channel 0 is filled with `value` and all other channels are 0. */
function protoTensorChannel0(value: number): TypedResults[string] {
  const data = new Float32Array(32 * PROTO * PROTO);
  for (let i = 0; i < PROTO * PROTO; i++) data[i] = value;
  return { data, dims: [1, 32, PROTO, PROTO] };
}

function run(ctx: Partial<PostprocessContext> & { results: TypedResults }) {
  return processInstanceSegmentation({
    config: makeConfig(),
    scoreThreshold: 0.5,
    originalWidth: 160,
    originalHeight: 160,
    ...ctx,
  });
}

describe('processInstanceSegmentation — filtering', () => {
  it('keeps only target-class detections above the score threshold', () => {
    const results: TypedResults = {
      output0: detectionsTensor([
        det({ x1: 0, y1: 0, x2: 160, y2: 160, conf: 0.75, cls: 0, coeffs: [10] }), // person, kept
        det({ x1: 0, y1: 0, x2: 160, y2: 160, conf: 0.75, cls: 1 }), // cat, not a target class
        det({ x1: 0, y1: 0, x2: 160, y2: 160, conf: 0.25, cls: 0 }), // person, below threshold
        det({ x1: 200, y1: 200, x2: 300, y2: 300, conf: 0.75, cls: 0 }), // person, outside content
      ]),
      output1: protoTensorChannel0(1),
    };

    const predictions = run({ results });

    expect(predictions).toHaveLength(1);
    expect(predictions[0]).toMatchObject({
      classId: 0,
      className: 'person',
      probability: 0.75,
      boundingBox: { x: 0, y: 0, width: 160, height: 160 },
    });
  });

  it('keeps a detection whose confidence exactly equals the threshold', () => {
    const results: TypedResults = {
      output0: detectionsTensor([det({ x1: 0, y1: 0, x2: 160, y2: 160, conf: 0.5, cls: 0 })]),
      output1: protoTensorChannel0(1),
    };

    expect(run({ results, scoreThreshold: 0.5 })).toHaveLength(1);
  });

  it('returns no predictions when the detections tensor is missing', () => {
    expect(run({ results: {} })).toEqual([]);
  });

  it('returns no predictions for an empty detection list', () => {
    expect(run({ results: { output0: detectionsTensor([]) } })).toEqual([]);
  });
});

describe('processInstanceSegmentation — mask decoding', () => {
  it('encodes an all-on mask when the coefficients drive sigmoid above 0.5', () => {
    const results: TypedResults = {
      output0: detectionsTensor([det({ x1: 0, y1: 0, x2: 160, y2: 160, conf: 0.75, cls: 0, coeffs: [10] })]),
      output1: protoTensorChannel0(1), // sum = 10 -> sigmoid ~1 -> all pixels on
    };

    expect(run({ results })[0]?.masks).toEqual({
      width: PROTO,
      height: PROTO,
      startValue: 1,
      runs: [PROTO * PROTO],
    });
  });

  it('encodes an all-off mask when the coefficients drive sigmoid below 0.5', () => {
    const results: TypedResults = {
      output0: detectionsTensor([det({ x1: 0, y1: 0, x2: 160, y2: 160, conf: 0.75, cls: 0, coeffs: [-10] })]),
      output1: protoTensorChannel0(1), // sum = -10 -> sigmoid ~0 -> all pixels off
    };

    expect(run({ results })[0]?.masks).toEqual({
      width: PROTO,
      height: PROTO,
      startValue: 0,
      runs: [PROTO * PROTO],
    });
  });

  it('emits an empty mask when no prototype tensor is present', () => {
    const results: TypedResults = {
      output0: detectionsTensor([det({ x1: 0, y1: 0, x2: 160, y2: 160, conf: 0.75, cls: 0, coeffs: [10] })]),
    };

    expect(run({ results })[0]?.masks).toEqual({ width: 0, height: 0, startValue: 0, runs: [] });
  });
});

describe('processInstanceSegmentation — letterbox offset removal and clamping', () => {
  it('removes the vertical letterbox and scales boxes back to original coordinates', () => {
    // 320x160 image in a 160x160 model -> scale 0.5, 40px letterbox top & bottom, scale-back factor 2.
    const results: TypedResults = {
      output0: detectionsTensor([
        // Box spanning the full content area maps back to the whole original image.
        det({ x1: 0, y1: 40, x2: 160, y2: 120, conf: 0.75, cls: 0 }),
        // Box reaching up into the top padding clamps to the content edge before scaling.
        det({ x1: 40, y1: 20, x2: 120, y2: 100, conf: 0.75, cls: 0 }),
      ]),
    };

    const predictions = processInstanceSegmentation({
      config: makeConfig(),
      scoreThreshold: 0.5,
      originalWidth: 320,
      originalHeight: 160,
      results,
    });

    expect(predictions.map(p => p.boundingBox)).toEqual([
      { x: 0, y: 0, width: 320, height: 160 },
      { x: 80, y: 0, width: 160, height: 120 },
    ]);
  });
});
