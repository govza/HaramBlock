import { describe, expect, it } from 'vitest';

import { INFERENCE_PRIORITY } from '@/utils/constants/inference';
import { chunked, CLEAN, createHarness, fixture, suspicious, unsafe } from '@/utils/lookahead/__tests__/harness';
import { createMseAnalysis } from '@/utils/lookahead/analysis';

const VP9_MIME = 'video/webm; codecs="vp9"';
const H264_MIME = 'video/mp4; codecs="avc1.64000a"';

describe('Lookahead Analysis over an MSE Source', () => {
  it('requests every level-0 Lattice Point with exact µs keys, however the appends are cut', async () => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, { live: false, suspicionThreshold: 0.25 });
    analysis.addBuffer('v', VP9_MIME);
    for (const chunk of chunked(fixture('mse-vp9.webm'), [777, 13, 4096, 1])) analysis.append('v', chunk, 0);
    await analysis.settled();

    expect(harness.requestedPoints()).toEqual([
      0, 500_000, 1_000_000, 1_500_000, 2_000_000, 2_500_000, 3_000_000, 3_500_000,
    ]);
  });

  it('places fMP4 samples in page media time by applying timestampOffset', async () => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, { live: false, suspicionThreshold: 0.25 });
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
    const analysis = createMseAnalysis(harness.ports, { live: false, suspicionThreshold: 0.25 });
    analysis.addBuffer('v', H264_MIME);
    analysis.append('v', fixture('mse-h264.mp4'), 0.01);
    await analysis.settled();

    expect(harness.requests[0]).toMatchObject({ pointUs: 500_000, ptsUs: 476_667 });
  });

  it('analyses the playhead first after a seek: its unit from the point at or after it, then on in playback order', async () => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, { live: false, suspicionThreshold: 0.25 });
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
    const analysis = createMseAnalysis(harness.ports, { live: false, suspicionThreshold: 0.25 });
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
    const analysis = createMseAnalysis(harness.ports, { live: false, suspicionThreshold: 0.25 });
    analysis.addBuffer('v', VP9_MIME);
    analysis.setVisible(false);
    analysis.append('v', fixture('mse-vp9.webm'), 0);
    await analysis.settled();

    expect(harness.requests.map(request => request.priority)).toEqual(
      Array.from({ length: 8 }, () => INFERENCE_PRIORITY.offscreenImage),
    );
  });

  it('cuts WebCodecs chunk appends into units at keyframes', async () => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, { live: false, suspicionThreshold: 0.25 });
    analysis.addBuffer('v', 'video/webm; codecs="vp9"');
    const frameUs = 100_000;
    const chunks = Array.from({ length: 31 }, (_, index) => ({
      data: new Uint8Array([index]),
      type: index % 10 === 0 ? ('key' as const) : ('delta' as const),
      timestampUs: index * frameUs,
      durationUs: frameUs,
    }));
    analysis.appendChunks('v', { codec: 'vp09.00.10.08' }, chunks);
    await analysis.settled();

    expect(harness.requestedPoints()).toEqual([0, 500_000, 1_000_000, 1_500_000, 2_000_000, 2_500_000]);
  });

  it('ignores audio SourceBuffers', async () => {
    const harness = createHarness();
    const analysis = createMseAnalysis(harness.ports, { live: false, suspicionThreshold: 0.25 });
    analysis.addBuffer('a', 'audio/webm; codecs="opus"');
    analysis.append('a', fixture('mse-vp9.webm'), 0);
    await analysis.settled();

    expect(harness.requests).toEqual([]);
  });
});

describe('Lookahead Analysis cache and refinement', () => {
  const appendVp9 = async (harness: ReturnType<typeof createHarness>, options = { live: false }) => {
    const analysis = createMseAnalysis(harness.ports, { live: options.live, suspicionThreshold: 0.25 });
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

  it('publishes every analysed sample with its top unsafe score, clean ones included', async () => {
    const harness = createHarness({ verdictAt: () => suspicious(0.1) });
    await appendVp9(harness);

    expect(harness.published).toHaveLength(8);
    expect(harness.published[0]).toMatchObject({ pointUs: 0, topUnsafeScore: 0.1, predictions: [] });
  });

  it('neither reads nor publishes the cache for a live session', async () => {
    const harness = createHarness({ cached: [{ pointUs: 1_000_000, ...CLEAN }] });
    await appendVp9(harness, { live: true });

    expect(harness.cacheReads()).toBe(0);
    expect(harness.published).toEqual([]);
    expect(harness.requestedPoints()).toContain(1_000_000);
  });

  it('refines disagreeing neighbours down to 62.5 ms', async () => {
    const harness = createHarness({ verdictAt: pointUs => (pointUs >= 2_000_000 ? unsafe() : CLEAN) });
    await appendVp9(harness);

    const probes = harness.requestedPoints().filter(pointUs => pointUs % 500_000 !== 0);
    expect(probes).toEqual([1_750_000, 1_875_000, 1_937_500]);
  });

  it('probes both sides of a Suspicious Clean sample', async () => {
    const harness = createHarness({ verdictAt: pointUs => (pointUs === 1_000_000 ? suspicious(0.3) : CLEAN) });
    await appendVp9(harness);

    const probes = harness.requestedPoints().filter(pointUs => pointUs % 500_000 !== 0);
    expect(probes.sort((a, b) => a - b)).toEqual([750_000, 1_250_000]);
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
    const analysis = createMseAnalysis(harness.ports, { live: false, suspicionThreshold: 0.25 });
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
