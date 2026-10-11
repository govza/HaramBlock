import { describe, expect, it } from 'vitest';

import { CLEAN, createHarness, fileSource, fixture, suspicious, unsafe } from '@/utils/lookahead/__tests__/harness';
import { createProgressiveAnalysis } from '@/utils/lookahead/analysis';

const OPTIONS = { liveness: 'vod', scoreThreshold: 0.5 } as const;

function mdatOffset(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === 'mdat') return offset;
    offset += view.getUint32(offset);
  }
  return -1;
}

describe('Lookahead Analysis over a Progressive Source', () => {
  it('samples a long-GOP file at its Keyframe Points', async () => {
    const harness = createHarness();
    const { source } = fileSource(fixture('progressive-long-gop.mp4'));
    const analysis = createProgressiveAnalysis(harness.ports, OPTIONS, source);
    analysis.setPlayhead({ timeSec: 0, playbackRate: 1, paused: true });
    await analysis.settled();

    expect(harness.requestedPoints()).toEqual([0, 5_000_000, 10_000_000]);
    expect(harness.requests.map(request => request.ptsUs)).toEqual([0, 5_000_000, 10_000_000]);
  });

  it.each(['90000', '15360'])(
    'samples the keyframe itself when a %s Hz keyframe PTS falls between microseconds',
    async timescale => {
      const harness = createHarness();
      const { source } = fileSource(fixture(`progressive-timescale-${timescale}.mp4`));
      const analysis = createProgressiveAnalysis(harness.ports, OPTIONS, source);
      analysis.setPlayhead({ timeSec: 0, playbackRate: 1, paused: true });
      await analysis.settled();

      expect(harness.requestedPoints()).toEqual([0, 1_033_334, 2_066_667]);
      expect(harness.requests.map(request => request.ptsUs)).toEqual([0, 1_033_333, 2_066_667]);
      expect(harness.jobs.map(job => job.packets.length)).toEqual([1, 1, 1]);
    },
  );

  it('decodes a refinement probe inside a long GOP from its keyframe', async () => {
    const harness = createHarness({ verdictAt: pointUs => (pointUs === 5_000_000 ? unsafe() : CLEAN) });
    const { source } = fileSource(fixture('progressive-long-gop.mp4'));
    const analysis = createProgressiveAnalysis(harness.ports, OPTIONS, source);
    analysis.setPlayhead({ timeSec: 0, playbackRate: 1, paused: true });
    await analysis.settled();

    const probeJob = harness.jobs.find(job => job.targets.some(target => target.pointUs === 2_500_000));
    expect(probeJob?.packets[0]).toMatchObject({ type: 'key', timestampUs: 0 });
    expect(probeJob?.packets.at(-1)?.timestampUs).toBe(2_500_000);
  });

  it('keeps a probe beyond the window and runs it once the window reaches it', async () => {
    const harness = createHarness({ verdictAt: pointUs => (pointUs === 1_000_000 ? suspicious() : CLEAN) });
    const { source } = fileSource(fixture('progressive-short-gop.mp4'));
    const analysis = createProgressiveAnalysis(harness.ports, OPTIONS, source, { windowSec: 1.1 });
    analysis.setPlayhead({ timeSec: 0, playbackRate: 1, paused: false });
    await analysis.settled();
    expect(harness.requestedPoints()).toEqual([0, 500_000, 1_000_000, 750_000]);

    analysis.setPlayhead({ timeSec: 0.1, playbackRate: 1, paused: false });
    await analysis.settled();
    expect(harness.requestedPoints()).not.toContain(1_250_000);

    analysis.setPlayhead({ timeSec: 0.5, playbackRate: 1, paused: false });
    await analysis.settled();
    expect(harness.requestedPoints()).toContain(1_250_000);
  });

  it('samples short GOPs at Lattice Points', async () => {
    const harness = createHarness();
    const { source } = fileSource(fixture('progressive-short-gop.mp4'));
    const analysis = createProgressiveAnalysis(harness.ports, OPTIONS, source);
    analysis.setPlayhead({ timeSec: 0, playbackRate: 1, paused: true });
    await analysis.settled();

    expect(harness.requestedPoints()).toEqual([
      0, 500_000, 1_000_000, 1_500_000, 2_000_000, 2_500_000, 3_000_000, 3_500_000,
    ]);
  });

  it('runs ahead only within its window and refills it as the playhead advances', async () => {
    const harness = createHarness();
    const { source } = fileSource(fixture('progressive-short-gop.mp4'));
    const analysis = createProgressiveAnalysis(harness.ports, OPTIONS, source, { windowSec: 1.5 });
    analysis.setPlayhead({ timeSec: 0, playbackRate: 1, paused: false });
    await analysis.settled();
    expect(harness.requestedPoints()).toEqual([0, 500_000, 1_000_000]);

    analysis.setPlayhead({ timeSec: 1.2, playbackRate: 1, paused: false });
    await analysis.settled();
    expect(harness.requestedPoints()).toEqual([0, 500_000, 1_000_000, 1_500_000, 2_000_000, 2_500_000]);
  });

  it('pauses the window fill while offscreen', async () => {
    const harness = createHarness();
    const { source } = fileSource(fixture('progressive-short-gop.mp4'));
    const analysis = createProgressiveAnalysis(harness.ports, OPTIONS, source, { windowSec: 1.5 });
    analysis.setVisible(false);
    analysis.setPlayhead({ timeSec: 0, playbackRate: 1, paused: false });
    await analysis.settled();

    expect(harness.requests).toEqual([]);
  });

  it('reports a rejected first range request as an unreachable bitstream', async () => {
    const harness = createHarness();
    const { source } = fileSource(fixture('progressive-short-gop.mp4'), { failFirst: true });
    const analysis = createProgressiveAnalysis(harness.ports, OPTIONS, source);
    await analysis.settled();

    expect(harness.unreachable).toEqual(['fetch']);
  });

  it('never fetches the media of a fully cached range', async () => {
    const bytes = fixture('progressive-short-gop.mp4');
    const cached = [0, 500_000, 1_000_000, 1_500_000, 2_000_000, 2_500_000, 3_000_000, 3_500_000].map(pointUs => ({
      pointUs,
      ...CLEAN,
    }));
    const harness = createHarness({ cached });
    const { source, reads } = fileSource(bytes);
    const analysis = createProgressiveAnalysis(harness.ports, OPTIONS, source);
    analysis.setPlayhead({ timeSec: 0, playbackRate: 1, paused: true });
    await analysis.settled();

    expect(harness.decodeJobs()).toBe(0);
    const mediaStart = mdatOffset(bytes) + 16;
    expect(reads.filter(([, end]) => end > mediaStart)).toEqual([]);
  });
});
