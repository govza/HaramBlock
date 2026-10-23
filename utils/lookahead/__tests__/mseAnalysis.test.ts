import { afterEach, describe, expect, it, vi } from 'vitest';

import { INFERENCE_PRIORITY } from '@/utils/constants/inference';
import {
  chunked,
  CLEAN,
  createHarness,
  fixture,
  suspicious,
  unsafe,
  type TestFrame,
  CLUSTER_ID,
  indexesOfBytes,
  withUnknownSizes,
  VOD_OPTIONS,
  KNOWN_IDENTITY,
  PLAYING_ASPECT_RATIO,
} from '@/utils/lookahead/__tests__/harness';
import { createMseAnalysis } from '@/utils/lookahead/analysis';

import type { DecoderPort, InferencePort, Liveness } from '@/utils/lookahead/ports';
import type { VideoIdentity } from '@/utils/types';

const VP9_MIME = 'video/webm; codecs="vp9"';
const H264_MIME = 'video/mp4; codecs="avc1.64000a"';

describe('Lookahead Analysis over an MSE Source', () => {
  it('requests every level-0 Lattice Point with exact µs keys, however the appends are cut', async () => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, VOD_OPTIONS);
    analysis.addBuffer('v', VP9_MIME);
    for (const chunk of chunked(fixture('mse-vp9.webm'), [777, 13, 4096, 1])) analysis.append('v', chunk, 0);
    await analysis.settled();

    expect(harness.requestedPoints()).toEqual([
      0, 500_000, 1_000_000, 1_500_000, 2_000_000, 2_500_000, 3_000_000, 3_500_000,
    ]);
  });

  it('places fMP4 samples in page media time by applying timestampOffset', async () => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, VOD_OPTIONS);
    analysis.addBuffer('v', H264_MIME);
    analysis.append('v', fixture('mse-h264.mp4'), 10);
    await analysis.settled();

    expect(harness.requestedPoints()).toEqual([
      10_500_000, 11_000_000, 11_500_000, 12_000_000, 12_500_000, 13_000_000, 13_500_000, 14_000_000,
    ]);
    expect(harness.requests[0]).toMatchObject({ pointUs: 10_500_000, ptsUs: 10_500_000 });
  });

  it('describes a Lattice Point by the last frame presented at or before it', async () => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, VOD_OPTIONS);
    analysis.addBuffer('v', H264_MIME);
    analysis.append('v', fixture('mse-h264.mp4'), 0.01);
    await analysis.settled();

    expect(harness.requests[0]).toMatchObject({ pointUs: 500_000, ptsUs: 476_667 });
  });

  it('analyses the playhead first after a seek: its unit from the point at or after it, then on in playback order', async () => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, VOD_OPTIONS);
    analysis.addBuffer('v', VP9_MIME);
    analysis.setPlayhead({ timeSec: 2.2, playbackRate: 1, paused: false });
    analysis.append('v', fixture('mse-vp9.webm'), 0);
    await analysis.settled();

    expect(harness.requestedPoints()).toEqual([
      2_500_000, 2_000_000, 3_000_000, 3_500_000, 0, 500_000, 1_000_000, 1_500_000,
    ]);
  });

  it('marks samples within ~5 s of slack urgent and the rest as ordinary lookahead', async () => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, VOD_OPTIONS);
    analysis.addBuffer('v', H264_MIME);
    analysis.setPlayhead({ timeSec: 6, playbackRate: 1, paused: false });
    analysis.append('v', fixture('mse-h264.mp4'), 8);
    await analysis.settled();

    const priorityAt = (pointUs: number) => harness.requests.find(request => request.pointUs === pointUs)?.priority;
    expect(priorityAt(10_500_000)).toBe(INFERENCE_PRIORITY.lookaheadUrgent);
    expect(priorityAt(11_000_000)).toBe(INFERENCE_PRIORITY.videoFrame);
  });

  it('analyses at the lowest priority while the video is offscreen', async () => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, VOD_OPTIONS);
    analysis.addBuffer('v', VP9_MIME);
    analysis.setVisible(false);
    analysis.append('v', fixture('mse-vp9.webm'), 0);
    await analysis.settled();

    expect(harness.requests.map(request => request.priority)).toEqual(
      Array.from({ length: 8 }, () => INFERENCE_PRIORITY.offscreenImage),
    );
  });

  it.each([
    ['WebM', VP9_MIME, 'mse-vp9.webm', [0x1f, 0x43, 0xb6, 0x75]],
    ['fMP4', H264_MIME, 'mse-h264.mp4', [0x6d, 0x6f, 0x6f, 0x66]],
  ])('resumes at the next %s unit after bytes went missing', async (_label, mime, file, unitMarker) => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, VOD_OPTIONS);
    analysis.addBuffer('v', mime);
    const bytes = fixture(file);
    const marker = unitMarker;
    const firstUnit = indexOfBytes(bytes, marker);
    const secondUnit = indexOfBytes(bytes.subarray(firstUnit + 4), marker) + firstUnit + 4;
    const unitStart = marker[0] === 0x6d ? 4 : 0;
    analysis.append('v', bytes.slice(0, firstUnit - unitStart + 300), 0);
    analysis.append('v', bytes.slice(secondUnit - unitStart - 100), 0, true);
    await analysis.settled();

    expect(harness.unreachable).toEqual([]);
    expect(harness.requestedPoints().filter(point => point >= 2_000_000).length).toBeGreaterThan(0);
  });

  it('analyses the last keyframe group of a chunk append without waiting for the next keyframe', async () => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, VOD_OPTIONS);
    analysis.addBuffer('v', VP9_MIME);
    analysis.appendChunks('v', { codec: 'vp09.00.10.08' }, chunksAt(0, 25));
    await analysis.settled();

    expect(harness.requestedPoints()).toEqual([0, 500_000, 1_000_000, 1_500_000, 2_000_000]);
  });

  it('extends a keyframe group continued by a later chunk append', async () => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, VOD_OPTIONS);
    analysis.addBuffer('v', VP9_MIME);
    analysis.appendChunks('v', { codec: 'vp09.00.10.08' }, chunksAt(0, 13));
    await analysis.settled();
    analysis.appendChunks('v', { codec: 'vp09.00.10.08' }, chunksAt(13, 20));
    await analysis.settled();

    expect(harness.requestedPoints()).toEqual([0, 500_000, 1_000_000, 1_500_000]);
    expect(harness.requests.at(-1)).toMatchObject({ pointUs: 1_500_000, ptsUs: 1_500_000 });
  });

  it('analyses a trailing unknown-size Cluster once the stream ends', async () => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, VOD_OPTIONS);
    analysis.addBuffer('v', VP9_MIME);
    analysis.append('v', withUnknownSizes(fixture('mse-vp9.webm')), 0);
    await analysis.settled();
    const beforeEnd = harness.requestedPoints();
    analysis.endOfStream('v');
    await analysis.settled();

    expect(beforeEnd).not.toContain(3_500_000);
    expect(harness.requestedPoints()).toEqual([
      0, 500_000, 1_000_000, 1_500_000, 2_000_000, 2_500_000, 3_000_000, 3_500_000,
    ]);
  });

  it('places each unknown-size Cluster with the timestampOffset of the append that carried it', async () => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, VOD_OPTIONS);
    analysis.addBuffer('v', VP9_MIME);
    const bytes = withUnknownSizes(fixture('mse-vp9.webm'));
    const cuts = [0, ...indexesOfBytes(bytes, CLUSTER_ID).slice(1), bytes.length];
    cuts.slice(1).forEach((end, index) => analysis.append('v', bytes.slice(cuts[index], end), index * 10));
    analysis.endOfStream('v');
    await analysis.settled();

    expect(harness.requestedPoints()).toEqual([
      0, 500_000, 11_000_000, 11_500_000, 22_000_000, 22_500_000, 33_000_000, 33_500_000,
    ]);
  });

  it('maps each frame of a unit spanning appends with the timestampOffset of the append that delivered it', async () => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, VOD_OPTIONS);
    analysis.addBuffer('v', H264_MIME);
    const bytes = fixture('mse-h264.mp4');
    const [firstMdat = 0] = indexesOfBytes(bytes, MDAT_TYPE);
    const [, secondMoof = 0] = indexesOfBytes(bytes, MOOF_TYPE);
    const midFirstMdat = firstMdat + 1260;
    analysis.append('v', bytes.slice(0, midFirstMdat), 0);
    analysis.append('v', bytes.slice(midFirstMdat, secondMoof - 4), 10);
    await analysis.settled();

    const decodedPts = harness.jobs.flatMap(job => job.packets.map(packet => packet.timestampUs));
    expect(decodedPts.some(pts => pts < 1_000_000)).toBe(true);
    expect(decodedPts.some(pts => pts > 10_000_000)).toBe(true);
    expect(decodedPts.filter(pts => pts >= 1_000_000 && pts <= 10_000_000)).toEqual([]);
  });

  it('ignores audio SourceBuffers', async () => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, VOD_OPTIONS);
    analysis.addBuffer('a', 'audio/webm; codecs="opus"');
    analysis.append('a', fixture('mse-vp9.webm'), 0);
    await analysis.settled();

    expect(harness.requests).toEqual([]);
  });

  it('never drops a unit it has not analysed, however many arrive while inference is backed up', async () => {
    const harness = createHarness();
    const held: (() => void)[] = [];
    let holding = true;
    const inference: InferencePort = {
      infer: request => {
        harness.requests.push({ pointUs: request.pointUs, ptsUs: 0, priority: request.priority });
        return new Promise(resolve => {
          const answer = () => resolve(CLEAN);
          if (holding) held.push(answer);
          else answer();
        });
      },
    };
    const analysis = createMseAnalysis({ ...harness.ports, inference }, VOD_OPTIONS);
    analysis.addBuffer('v', VP9_MIME);
    const copies = 20;
    for (let copy = 0; copy < copies; copy += 1) analysis.append('v', fixture('mse-vp9.webm'), copy * 4);
    await vi.waitFor(() => expect(held.length).toBeGreaterThan(0));
    await new Promise(resolve => setTimeout(resolve, 50));

    holding = false;
    for (const answer of held.splice(0)) answer();
    await analysis.settled();

    const expected = Array.from({ length: copies }, (_, copy) =>
      Array.from({ length: 8 }, (_, index) => copy * 4_000_000 + index * 500_000),
    ).flat();
    expect(new Set(harness.requestedPoints())).toEqual(new Set(expected));
  });
  it('closes every decoded frame once its inference settles, answered or failed', async () => {
    const harness = createHarness();
    const inference: InferencePort = {
      infer: request =>
        request.pointUs === 1_000_000 ? Promise.reject(new Error('inference failed')) : Promise.resolve(CLEAN),
    };
    const analysis = createMseAnalysis({ ...harness.ports, inference }, VOD_OPTIONS);
    analysis.addBuffer('v', VP9_MIME);
    analysis.append('v', fixture('mse-vp9.webm'), 0);
    await analysis.settled();

    expect(harness.frames).toHaveLength(8);
    expect(harness.frames.filter(frame => !frame.closed)).toEqual([]);
  });

  it('closes the frames already decoded when decoding fails part-way', async () => {
    const harness = createHarness();
    const frames: TestFrame[] = [];
    const decoder: DecoderPort = {
      async *decode(job) {
        const [target] = job.targets;
        if (!target) return;
        const frame: TestFrame = {
          ptsUs: target.ptsUs,
          closed: false,
          close() {
            this.closed = true;
          },
        };
        frames.push(frame);
        yield { target, frame };
        await Promise.reject(new Error('decoder crashed'));
      },
    };
    const analysis = createMseAnalysis({ ...harness.ports, decoder }, VOD_OPTIONS);
    analysis.addBuffer('v', VP9_MIME);
    analysis.append('v', fixture('mse-vp9.webm'), 0);
    await analysis.settled();

    expect(harness.unreachable).toEqual(['decode']);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.filter(frame => !frame.closed)).toEqual([]);
  });

  it('holds no analysed unit except the newest, which a later unit may still refine into', async () => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, VOD_OPTIONS);
    analysis.addBuffer('v', VP9_MIME);
    analysis.append('v', fixture('mse-vp9.webm'), 0);
    await analysis.settled();

    expect(analysis.heldUnits()).toBe(1);
  });
});

describe('Lookahead Analysis cache under a video identity', () => {
  const ANOTHER_IDENTITY = { kind: 'stable', key: 'url:https://cdn.test/other.mp4', durationSec: 4 } as const;

  const UNIDENTIFIED = { identity: { kind: 'unknown' }, aspectRatio: PLAYING_ASPECT_RATIO } as const;
  const identifiedAs = (identity: VideoIdentity) => ({ identity, aspectRatio: PLAYING_ASPECT_RATIO });
  const withoutAspectRatio = { ...VOD_OPTIONS, readContext: { identity: KNOWN_IDENTITY, aspectRatio: null } };

  const startUnidentified = (harness: ReturnType<typeof createHarness>) => {
    const analysis = createMseAnalysis(harness.ports, { ...VOD_OPTIONS, readContext: UNIDENTIFIED });
    analysis.addBuffer('v', VP9_MIME);
    analysis.append('v', fixture('mse-vp9.webm'), 0);
    return analysis;
  };

  const settleWithFakeTimers = async (analysis: { settled(): Promise<void> }) => {
    const settled = analysis.settled();
    await vi.runAllTimersAsync();
    await settled;
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads and publishes under the identity the session opened with', async () => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, VOD_OPTIONS);
    analysis.addBuffer('v', VP9_MIME);
    analysis.append('v', fixture('mse-vp9.webm'), 0);
    await analysis.settled();

    expect(harness.readUnder).toEqual([KNOWN_IDENTITY.key]);
    expect(new Set(harness.publishedUnder)).toEqual(new Set([KNOWN_IDENTITY.key]));
  });

  it('reads the cache with the session strictness and the playing video aspect ratio', async () => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, VOD_OPTIONS);
    analysis.addBuffer('v', VP9_MIME);
    analysis.append('v', fixture('mse-vp9.webm'), 0);
    await analysis.settled();

    expect(harness.readAs).toEqual([{ aspectRatio: PLAYING_ASPECT_RATIO }]);
  });

  it('waits for the playing video aspect ratio before reading the cache', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, withoutAspectRatio);
    analysis.addBuffer('v', VP9_MIME);
    analysis.append('v', fixture('mse-vp9.webm'), 0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.cacheReads()).toBe(0);

    analysis.setReadContext({ identity: KNOWN_IDENTITY, aspectRatio: 4 / 3 });
    await settleWithFakeTimers(analysis);

    expect(harness.readAs).toEqual([{ aspectRatio: 4 / 3 }]);
  });

  it('reads without an aspect ratio once the identity wait runs out', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, withoutAspectRatio);
    analysis.addBuffer('v', VP9_MIME);
    analysis.append('v', fixture('mse-vp9.webm'), 0);
    await settleWithFakeTimers(analysis);

    expect(harness.readAs).toEqual([{ aspectRatio: null }]);
  });

  it('analyses an unidentified video without waiting for its identity', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ cached: [{ pointUs: 1_000_000, ...CLEAN }] });
    startUnidentified(harness);
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.cacheReads()).toBe(0);
    expect(harness.requestedPoints()).toContain(1_000_000);
  });

  it('reads the cache under the identity whenever it resolves, however late', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ cached: [{ pointUs: 1_000_000, ...CLEAN }] });
    const analysis = startUnidentified(harness);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.cacheReads()).toBe(0);

    analysis.setReadContext(identifiedAs(KNOWN_IDENTITY));
    await settleWithFakeTimers(analysis);

    expect(harness.readUnder).toEqual([KNOWN_IDENTITY.key]);
  });

  it('holds samples analysed while unidentified and publishes them under the identity once it resolves', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const analysis = startUnidentified(harness);
    await vi.advanceTimersByTimeAsync(3_000);
    await settleWithFakeTimers(analysis);
    expect(harness.emitted).toHaveLength(8);
    expect(harness.published).toEqual([]);

    analysis.setReadContext(identifiedAs(KNOWN_IDENTITY));

    expect(harness.published.map(sample => sample.pointUs)).toEqual(harness.emitted.map(sample => sample.pointUs));
    expect(new Set(harness.publishedUnder)).toEqual(new Set([KNOWN_IDENTITY.key]));
  });

  it('drops held samples when the session ends unidentified', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const analysis = startUnidentified(harness);
    await vi.advanceTimersByTimeAsync(3_000);
    await settleWithFakeTimers(analysis);

    analysis.stop();
    analysis.setReadContext(identifiedAs(KNOWN_IDENTITY));

    expect(harness.published).toEqual([]);
  });

  it('keeps the first identity it resolved for the rest of the session', async () => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, VOD_OPTIONS);
    analysis.addBuffer('v', VP9_MIME);
    analysis.append('v', fixture('mse-vp9.webm'), 0);
    analysis.setReadContext(identifiedAs(ANOTHER_IDENTITY));
    analysis.setReadContext(UNIDENTIFIED);
    await analysis.settled();

    expect(harness.readUnder).toEqual([KNOWN_IDENTITY.key]);
    expect(new Set(harness.publishedUnder)).toEqual(new Set([KNOWN_IDENTITY.key]));
  });

  it('still holds an identified session back while its liveness is unknown', async () => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, { ...VOD_OPTIONS, liveness: 'unknown' });
    analysis.addBuffer('v', VP9_MIME);
    analysis.append('v', fixture('mse-vp9.webm'), 0);
    await analysis.settled();
    expect(harness.published).toEqual([]);

    analysis.setLiveness('vod');

    expect(harness.published).toHaveLength(8);
  });
});

describe('Lookahead Analysis cache and refinement', () => {
  const appendVp9 = async (
    harness: ReturnType<typeof createHarness>,
    scoreThreshold = 0.5,
    liveness: Liveness = 'vod',
  ) => {
    const analysis = createMseAnalysis(harness.ports, { ...VOD_OPTIONS, liveness, scoreThreshold });
    analysis.addBuffer('v', VP9_MIME);
    analysis.append('v', fixture('mse-vp9.webm'), 0);
    await analysis.settled();
    return analysis;
  };

  it('never decodes a cached point and replays cached samples into the timeline', async () => {
    const cached = [1_000_000, 1_500_000].map(pointUs => ({ pointUs, ...CLEAN }));
    const harness = createHarness({ cached });
    await appendVp9(harness);

    expect(harness.requestedPoints()).not.toContain(1_000_000);
    expect(harness.requestedPoints()).not.toContain(1_500_000);
    expect(harness.emitted.map(sample => sample.pointUs)).toEqual(expect.arrayContaining([1_000_000, 1_500_000]));
    expect(harness.published.map(sample => sample.pointUs)).not.toContain(1_000_000);
  });

  it('publishes every analysed sample with its floor scores, clean ones under the reader threshold included', async () => {
    const harness = createHarness({ verdictAt: () => unsafe(0.1) });
    await appendVp9(harness);

    expect(harness.published).toHaveLength(8);
    expect(harness.published[0]).toEqual({ pointUs: 0, ...unsafe(0.1) });
  });

  it('neither reads nor publishes the cache for a live session', async () => {
    const harness = createHarness({ cached: [{ pointUs: 1_000_000, ...CLEAN }] });
    await appendVp9(harness, 0.5, 'live');

    expect(harness.cacheReads()).toBe(0);
    expect(harness.published).toEqual([]);
    expect(harness.requestedPoints()).toContain(1_000_000);
  });

  it('holds analysed samples back from the cache while liveness is unknown, publishing them once it is vod', async () => {
    const harness = createHarness();
    const analysis = await appendVp9(harness, 0.5, 'unknown');

    expect(harness.emitted).toHaveLength(8);
    expect(harness.published).toEqual([]);

    analysis.setLiveness('vod');

    expect(harness.published.map(sample => sample.pointUs)).toEqual(harness.emitted.map(sample => sample.pointUs));
  });

  it('never publishes a session that turns out live, neither held samples nor later ones', async () => {
    const harness = createHarness();
    const analysis = await appendVp9(harness, 0.5, 'unknown');

    analysis.setLiveness('live');
    analysis.setLiveness('vod');
    analysis.append('v', fixture('mse-vp9.webm'), 10);
    await analysis.settled();

    expect(harness.emitted.length).toBeGreaterThan(8);
    expect(harness.published).toEqual([]);
  });

  it('stops publishing a vod session once it turns live', async () => {
    const harness = createHarness();
    const analysis = await appendVp9(harness);
    const publishedBefore = harness.published.length;

    analysis.setLiveness('live');
    analysis.append('v', fixture('mse-vp9.webm'), 10);
    await analysis.settled();

    expect(harness.emitted.length).toBeGreaterThan(publishedBefore);
    expect(harness.published).toHaveLength(publishedBefore);
  });

  it('refines disagreeing neighbours down to 250 ms', async () => {
    const harness = createHarness({ verdictAt: pointUs => (pointUs >= 2_000_000 ? unsafe() : CLEAN) });
    await appendVp9(harness);

    const probes = harness.requestedPoints().filter(pointUs => pointUs % 500_000 !== 0);
    expect(probes).toEqual([1_750_000]);
  });

  it('probes both sides of a Suspicious Clean sample', async () => {
    const harness = createHarness({ verdictAt: pointUs => (pointUs === 1_000_000 ? suspicious(0.3) : CLEAN) });
    await appendVp9(harness);

    const probes = harness.requestedPoints().filter(pointUs => pointUs % 500_000 !== 0);
    expect(probes.sort((a, b) => a - b)).toEqual([750_000, 1_250_000]);
  });

  it.each([
    [0.5, [750_000, 1_250_000]],
    [0.3, [750_000, 1_250_000]],
  ])('judges a floor detection under the reader threshold %s', async (scoreThreshold, expectedProbes) => {
    const harness = createHarness({ verdictAt: pointUs => (pointUs === 1_000_000 ? unsafe(0.4) : CLEAN) });
    await appendVp9(harness, scoreThreshold);

    const probes = harness.requestedPoints().filter(pointUs => pointUs % 500_000 !== 0);
    expect(probes.sort((a, b) => a - b)).toEqual(expectedProbes);
  });

  it('completes refinements missing from cached samples', async () => {
    const cached = [
      { pointUs: 1_500_000, ...CLEAN },
      { pointUs: 2_000_000, ...unsafe() },
    ];
    const harness = createHarness({ cached, verdictAt: pointUs => (pointUs >= 2_000_000 ? unsafe() : CLEAN) });
    await appendVp9(harness);

    expect(harness.requestedPoints()).toContain(1_750_000);
    expect(harness.published.map(sample => sample.pointUs)).toContain(1_750_000);
  });

  it('reports a demux failure as an unreachable bitstream', async () => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, VOD_OPTIONS);
    analysis.addBuffer('v', VP9_MIME);
    const bytes = fixture('mse-vp9.webm');
    const firstCluster = indexOfBytes(bytes, [0x1f, 0x43, 0xb6, 0x75]);
    const garbageCluster = [0x1f, 0x43, 0xb6, 0x75, 0x84, 0xff, 0xff, 0xff, 0xff];
    analysis.append('v', new Uint8Array([...bytes.subarray(0, firstCluster), ...garbageCluster]), 0);
    await analysis.settled();

    expect(harness.unreachable).toEqual(['demux']);
    expect(harness.requests).toEqual([]);
  });
});

function indexOfBytes(haystack: Uint8Array, needle: readonly number[]): number {
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    if (needle.every((byte, offset) => haystack[i + offset] === byte)) return i;
  }
  return -1;
}

const MOOF_TYPE = [0x6d, 0x6f, 0x6f, 0x66];
const MDAT_TYPE = [0x6d, 0x64, 0x61, 0x74];

function chunksAt(from: number, to: number) {
  const frameUs = 100_000;
  return Array.from({ length: to - from }, (_, offset) => {
    const index = from + offset;
    return {
      data: new Uint8Array([index]),
      type: index % 10 === 0 ? ('key' as const) : ('delta' as const),
      timestampUs: index * frameUs,
      durationUs: frameUs,
    };
  });
}
