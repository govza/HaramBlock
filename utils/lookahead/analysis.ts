import { INFERENCE_PRIORITY } from '@/utils/constants/inference';
import {
  createUnitCutter,
  containerKindOf,
  type AnalysisUnitBytes,
  type UnitCutter,
} from '@/utils/lookahead/byteStream';
import { demuxUnit, type DemuxedUnit } from '@/utils/lookahead/demux';
import { latticePointsIn, latticeSpacingOf, probeBetween } from '@/utils/lookahead/lattice';
import {
  isUnsafeSample,
  type ByteRangeSource,
  type DecodeJob,
  type DecodedTarget,
  type EncodedSample,
  type LookaheadOptions,
  type LookaheadPorts,
  type Playhead,
  type StoredSample,
  type UnreachableReason,
} from '@/utils/lookahead/ports';
import { openProgressiveFile, UnreachableFetchError, type ProgressiveFile } from '@/utils/lookahead/progressiveFile';

export const URGENT_SLACK_SEC = 5;
const MAX_INFLIGHT_INFERENCES = 6;
const MAX_RETAINED_UNITS = 64;

export interface PointSource {
  readonly startUs: number;
  readonly endUs: number;
  readonly arrivedAt: number;
  pointsToSample(): number[];
  nextBatch(orderedPoints: readonly number[]): number[];
  buildJob(points: readonly number[]): Promise<DecodeJob | null>;
  release(): void;
}

export class SampleScheduler {
  private readonly known = new Map<number, StoredSample>();
  private readonly cachedUnreported = new Set<number>();
  private readonly wanted = new Set<number>();
  private readonly inflight = new Set<number>();
  private sources: PointSource[] = [];
  private playhead: Playhead = { timeSec: 0, playbackRate: 1, paused: true };
  private visible = true;
  private decoding = false;
  private pumpQueued = false;
  private pendingWork = 0;
  private stopped = false;
  private readonly cacheLoaded: Promise<void>;
  private cacheReady = false;
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly ports: LookaheadPorts,
    private readonly options: LookaheadOptions,
  ) {
    this.cacheLoaded = this.loadCache();
  }

  private async loadCache(): Promise<void> {
    if (!this.options.live) {
      try {
        const cached = await this.ports.cache.read();
        for (const sample of cached) {
          this.recordKnown(sample);
          this.cachedUnreported.add(sample.pointUs);
        }
        for (const sample of cached) this.ports.events.sample(sample);
      } catch {
        this.cacheReady = true;
      }
    }
    this.cacheReady = true;
    this.planRefinements();
    this.schedulePump();
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  setPlayhead(playhead: Playhead): void {
    this.playhead = playhead;
    this.schedulePump();
  }

  currentPlayhead(): Playhead {
    return this.playhead;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.schedulePump();
  }

  isVisible(): boolean {
    return this.visible;
  }

  isKnown(pointUs: number): boolean {
    return this.known.has(pointUs);
  }

  trackWork<T>(work: Promise<T>): Promise<T> {
    this.pendingWork += 1;
    return work.finally(() => {
      this.pendingWork -= 1;
      this.notifyIfIdle();
    });
  }

  addSource(source: PointSource): void {
    if (this.stopped) {
      source.release();
      return;
    }
    this.sources.push(source);
    this.refreshWanted(source);
    this.releaseResolvedSources();
    this.schedulePump();
  }

  refreshWanted(source: PointSource): void {
    for (const point of source.pointsToSample()) this.want(point);
    this.planRefinements();
    this.schedulePump();
  }

  pruneWanted(keep: (pointUs: number) => boolean): void {
    for (const point of this.wanted) {
      if (!keep(point)) this.wanted.delete(point);
    }
  }

  stop(reason?: UnreachableReason): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const source of this.sources) source.release();
    this.sources = [];
    this.wanted.clear();
    if (reason) this.ports.events.unreachable(reason);
    this.notifyIfIdle();
  }

  settled(): Promise<void> {
    return new Promise(resolve => {
      this.idleWaiters.push(resolve);
      this.notifyIfIdle();
    });
  }

  private want(pointUs: number): void {
    if (this.cachedUnreported.delete(pointUs)) this.ports.events.stat?.({ kind: 'cacheHit', pointUs });
    if (this.known.has(pointUs) || this.inflight.has(pointUs)) return;
    if (!this.sourceFor(pointUs)) return;
    this.wanted.add(pointUs);
  }

  private sourceFor(pointUs: number): PointSource | undefined {
    let best: PointSource | undefined;
    for (const source of this.sources) {
      if (pointUs < source.startUs || pointUs >= source.endUs) continue;
      if (!best || source.arrivedAt > best.arrivedAt) best = source;
    }
    return best;
  }

  private recordKnown(sample: StoredSample): void {
    this.known.set(sample.pointUs, sample);
    this.wanted.delete(sample.pointUs);
  }

  private sortedKnown(): StoredSample[] {
    return [...this.known.values()].sort((a, b) => a.pointUs - b.pointUs);
  }

  private isSuspiciousClean(sample: StoredSample): boolean {
    return !isUnsafeSample(sample) && sample.topUnsafeScore >= this.options.suspicionThreshold;
  }

  private planRefinements(): void {
    const samples = this.sortedKnown();
    samples.forEach((sample, index) => {
      const next = samples[index + 1];
      if (next && isUnsafeSample(sample) !== isUnsafeSample(next)) {
        this.wantProbe(sample.pointUs, next.pointUs);
      }
      if (this.isSuspiciousClean(sample)) {
        const spacingUs = latticeSpacingOf(sample.pointUs);
        this.wantProbe(sample.pointUs - spacingUs, sample.pointUs);
        this.wantProbe(sample.pointUs, sample.pointUs + spacingUs);
      }
    });
  }

  private wantProbe(earlierUs: number, laterUs: number): void {
    const probe = probeBetween(earlierUs, laterUs);
    if (probe !== null && probe >= 0) this.want(probe);
  }

  private orderKey(pointUs: number): [number, number] {
    const playheadUs = this.playhead.timeSec * 1e6;
    return [pointUs >= playheadUs ? 0 : 1, pointUs];
  }

  private compareOrder = (a: number, b: number): number => {
    const [aBehind, aTime] = this.orderKey(a);
    const [bBehind, bTime] = this.orderKey(b);
    return aBehind - bBehind || aTime - bTime;
  };

  priorityFor(pointUs: number): number {
    if (!this.visible) return INFERENCE_PRIORITY.offscreenImage;
    const slackSec = (pointUs / 1e6 - this.playhead.timeSec) / Math.max(this.playhead.playbackRate, 0.0625);
    return slackSec >= 0 && slackSec < URGENT_SLACK_SEC
      ? INFERENCE_PRIORITY.lookaheadUrgent
      : INFERENCE_PRIORITY.videoFrame;
  }

  schedulePump(): void {
    if (this.pumpQueued || this.stopped) return;
    this.pumpQueued = true;
    setTimeout(() => {
      this.pumpQueued = false;
      void this.pump();
    }, 0);
  }

  private async pump(): Promise<void> {
    if (this.stopped || this.decoding || !this.cacheReady) {
      this.notifyIfIdle();
      return;
    }
    if (this.inflight.size >= MAX_INFLIGHT_INFERENCES) return;
    const next = [...this.wanted].sort(this.compareOrder)[0];
    if (next === undefined) {
      this.notifyIfIdle();
      return;
    }
    const source = this.sourceFor(next);
    if (!source) {
      this.wanted.delete(next);
      this.schedulePump();
      return;
    }
    const points = source.nextBatch(
      [...this.wanted].filter(point => this.sourceFor(point) === source).sort(this.compareOrder),
    );
    for (const point of points) {
      this.wanted.delete(point);
      this.inflight.add(point);
    }
    this.decoding = true;
    try {
      await this.cacheLoaded;
      const job = await source.buildJob(points);
      if (job) await this.decodeAndInfer(job, points);
      else for (const point of points) this.inflight.delete(point);
    } catch {
      for (const point of points) this.inflight.delete(point);
      this.ports.events.stat?.({ kind: 'decodeFailed' });
      this.stop('decode');
    } finally {
      this.decoding = false;
      this.schedulePump();
    }
  }

  private async decodeAndInfer(job: DecodeJob, orderedPoints: readonly number[]): Promise<void> {
    const decoded = new Map<number, DecodedTarget>();
    for await (const item of this.ports.decoder.decode(job)) {
      if (this.stopped) {
        item.frame.close();
        continue;
      }
      decoded.set(item.target.pointUs, item);
    }
    for (const point of orderedPoints) {
      const item = decoded.get(point);
      if (!item) {
        this.inflight.delete(point);
        continue;
      }
      if (this.stopped) {
        item.frame.close();
        continue;
      }
      this.submitInference(point, item);
    }
  }

  private submitInference(pointUs: number, item: DecodedTarget): void {
    const request = this.ports.inference.infer({ pointUs, frame: item.frame, priority: this.priorityFor(pointUs) });
    void this.trackWork(
      request.then(
        inferred => {
          this.inflight.delete(pointUs);
          if (this.stopped) return;
          const sample: StoredSample = { pointUs, ...inferred };
          this.recordKnown(sample);
          this.ports.events.stat?.({ kind: 'analysed', pointUs });
          this.ports.events.sample(sample);
          if (!this.options.live) this.ports.cache.publish([sample]);
          this.planRefinements();
          this.releaseResolvedSources();
          this.schedulePump();
        },
        () => {
          this.inflight.delete(pointUs);
          this.schedulePump();
        },
      ),
    );
  }

  private hasPendingIn(source: PointSource): boolean {
    const inside = (point: number) => point >= source.startUs && point < source.endUs;
    return [...this.wanted].some(inside) || [...this.inflight].some(inside);
  }

  private releaseResolvedSources(): void {
    const keep: PointSource[] = [];
    const knownPoints = [...this.known.keys()];
    for (const source of this.sources) {
      const resolvedAfter = knownPoints.some(point => point >= source.endUs);
      if (!this.hasPendingIn(source) && resolvedAfter) source.release();
      else keep.push(source);
    }
    while (keep.length > MAX_RETAINED_UNITS) {
      const oldestResolved = keep.findIndex(source => !this.hasPendingIn(source));
      if (oldestResolved < 0) break;
      keep.splice(oldestResolved, 1)[0]?.release();
    }
    this.sources = keep;
  }

  private notifyIfIdle(): void {
    const idle =
      this.stopped ||
      (this.cacheReady &&
        !this.decoding &&
        !this.pumpQueued &&
        this.pendingWork === 0 &&
        this.inflight.size === 0 &&
        this.wanted.size === 0);
    if (!idle) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

class UnitSource implements PointSource {
  readonly startUs: number;
  readonly endUs: number;
  private unit: DemuxedUnit | null;

  constructor(
    unit: DemuxedUnit,
    readonly arrivedAt: number,
  ) {
    this.unit = unit;
    this.startUs = unit.startUs;
    this.endUs = unit.endUs;
  }

  pointsToSample(): number[] {
    return latticePointsIn(this.startUs, this.endUs);
  }

  nextBatch(orderedPoints: readonly number[]): number[] {
    return [...orderedPoints];
  }

  buildJob(points: readonly number[]): Promise<DecodeJob | null> {
    const { unit } = this;
    if (!unit) return Promise.resolve(null);
    return Promise.resolve(jobForPoints(unit.config, unit.packets, points));
  }

  release(): void {
    this.unit = null;
  }
}

export function jobForPoints(
  config: VideoDecoderConfig,
  packetsInDecodeOrder: readonly EncodedSample[],
  points: readonly number[],
): DecodeJob | null {
  const firstKey = packetsInDecodeOrder.findIndex(packet => packet.type === 'key');
  if (firstKey < 0) return null;
  const decodable = packetsInDecodeOrder.slice(firstKey);
  const targets = points.flatMap(pointUs => {
    let target: EncodedSample | undefined;
    for (const packet of decodable) {
      if (packet.timestampUs <= pointUs && (!target || packet.timestampUs > target.timestampUs)) target = packet;
    }
    return target ? [{ pointUs, ptsUs: target.timestampUs }] : [];
  });
  if (targets.length === 0) return null;
  const targetPts = new Set(targets.map(target => target.ptsUs));
  let lastNeeded = 0;
  decodable.forEach((packet, index) => {
    if (targetPts.has(packet.timestampUs)) lastNeeded = index;
  });
  return { config, packets: decodable.slice(0, lastNeeded + 1), targets };
}

interface BufferState {
  cutter: UnitCutter | null;
  chunkGroup: EncodedSample[];
  chunkConfig: VideoDecoderConfig | null;
}

export interface MseAnalysis {
  addBuffer(bufferId: string, mime: string): void;
  changeType(bufferId: string, mime: string): void;
  append(bufferId: string, bytes: Uint8Array, timestampOffsetSec: number): void;
  appendChunks(bufferId: string, config: VideoDecoderConfig, chunks: readonly EncodedSample[]): void;
  removeBuffer(bufferId: string): void;
  setPlayhead(playhead: Playhead): void;
  setVisible(visible: boolean): void;
  stop(): void;
  settled(): Promise<void>;
}

export function createMseAnalysis(ports: LookaheadPorts, options: LookaheadOptions): MseAnalysis {
  const scheduler = new SampleScheduler(ports, options);
  const buffers = new Map<string, BufferState>();
  let arrivals = 0;
  let demuxChain: Promise<void> = Promise.resolve();

  const addUnit = (unit: DemuxedUnit) => {
    arrivals += 1;
    scheduler.addSource(new UnitSource(unit, arrivals));
  };

  const enqueueDemux = (unit: AnalysisUnitBytes, offsetUs: number) => {
    demuxChain = scheduler.trackWork(
      demuxChain.then(async () => {
        if (scheduler.isStopped) return;
        try {
          addUnit(await demuxUnit(unit, offsetUs));
        } catch {
          ports.events.stat?.({ kind: 'unitDemuxFailed' });
          scheduler.stop('demux');
        }
      }),
    );
  };

  const bufferFor = (bufferId: string): BufferState | undefined => buffers.get(bufferId);

  const closeChunkGroup = (state: BufferState) => {
    const group = state.chunkGroup;
    const config = state.chunkConfig;
    state.chunkGroup = [];
    if (!config || group.length === 0) return;
    const startUs = Math.min(...group.map(sample => sample.timestampUs));
    const endUs = Math.max(...group.map(sample => sample.timestampUs + sample.durationUs));
    addUnit({ config, packets: group, startUs, endUs });
  };

  return {
    addBuffer(bufferId, mime) {
      if (mime.toLowerCase().startsWith('audio/')) return;
      const kind = containerKindOf(mime);
      buffers.set(bufferId, { cutter: kind ? createUnitCutter(kind) : null, chunkGroup: [], chunkConfig: null });
    },
    changeType(bufferId, mime) {
      if (!buffers.has(bufferId)) return;
      const kind = containerKindOf(mime);
      buffers.set(bufferId, { cutter: kind ? createUnitCutter(kind) : null, chunkGroup: [], chunkConfig: null });
    },
    append(bufferId, bytes, timestampOffsetSec) {
      const cutter = bufferFor(bufferId)?.cutter;
      if (!cutter || scheduler.isStopped) return;
      const offsetUs = Math.round(timestampOffsetSec * 1e6);
      for (const unit of cutter.push(bytes).units) enqueueDemux(unit, offsetUs);
    },
    appendChunks(bufferId, config, chunks) {
      const state = bufferFor(bufferId);
      if (!state || scheduler.isStopped) return;
      for (const chunk of chunks) {
        if (chunk.type === 'key') closeChunkGroup(state);
        state.chunkConfig = config;
        state.chunkGroup.push(chunk);
      }
    },
    removeBuffer(bufferId) {
      buffers.delete(bufferId);
    },
    setPlayhead: playhead => scheduler.setPlayhead(playhead),
    setVisible: visible => scheduler.setVisible(visible),
    stop: () => scheduler.stop(),
    settled: async () => {
      await demuxChain;
      await scheduler.settled();
    },
  };
}

const DEFAULT_WINDOW_SEC = 60;
export interface ProgressiveAnalysis {
  setPlayhead(playhead: Playhead): void;
  setVisible(visible: boolean): void;
  stop(): void;
  settled(): Promise<void>;
}

class ProgressiveSource implements PointSource {
  readonly startUs = 0;
  readonly arrivedAt = 0;

  constructor(
    private readonly scheduler: SampleScheduler,
    private readonly file: ProgressiveFile,
    private readonly windowUs: number,
  ) {}

  get endUs(): number {
    return this.file.durationUs + 1;
  }

  private windowBounds(): [number, number] {
    const playheadUs = this.scheduler.currentPlayhead().timeSec * 1e6;
    const points = this.file.gops.flatMap(gop => gop.points);
    const startUs = points.filter(point => point <= playheadUs).at(-1) ?? 0;
    return [startUs, playheadUs + this.windowUs];
  }

  inWindow(pointUs: number): boolean {
    const [startUs, endUs] = this.windowBounds();
    return pointUs >= startUs && pointUs < endUs;
  }

  pointsToSample(): number[] {
    if (!this.scheduler.isVisible()) return [];
    return this.file.gops.flatMap(gop => gop.points).filter(point => this.inWindow(point));
  }

  nextBatch(orderedPoints: readonly number[]): number[] {
    const [first] = orderedPoints;
    if (first === undefined) return [];
    const gop = this.file.gopOf(first);
    return orderedPoints.filter(point => this.file.gopOf(point) === gop);
  }

  buildJob(points: readonly number[]): Promise<DecodeJob | null> {
    return this.file.jobFor(points);
  }

  release(): void {
    this.file.dispose();
  }
}

export function createProgressiveAnalysis(
  ports: LookaheadPorts,
  options: LookaheadOptions,
  bytes: ByteRangeSource,
  config: { windowSec?: number } = {},
): ProgressiveAnalysis {
  const scheduler = new SampleScheduler(ports, options);
  let source: ProgressiveSource | null = null;

  const refresh = () => {
    if (!source) return;
    const current = source;
    if (scheduler.isVisible()) scheduler.pruneWanted(point => current.inWindow(point));
    else scheduler.pruneWanted(() => false);
    scheduler.refreshWanted(current);
  };

  const opening = scheduler.trackWork(
    openProgressiveFile(bytes).then(
      file => {
        if (scheduler.isStopped) {
          file.dispose();
          return;
        }
        source = new ProgressiveSource(scheduler, file, (config.windowSec ?? DEFAULT_WINDOW_SEC) * 1e6);
        scheduler.addSource(source);
      },
      (error: unknown) => {
        scheduler.stop(error instanceof UnreachableFetchError ? 'fetch' : 'demux');
      },
    ),
  );

  return {
    setPlayhead(playhead) {
      scheduler.setPlayhead(playhead);
      refresh();
    },
    setVisible(visible) {
      scheduler.setVisible(visible);
      refresh();
    },
    stop: () => scheduler.stop(),
    settled: async () => {
      await opening;
      await scheduler.settled();
    },
  };
}
