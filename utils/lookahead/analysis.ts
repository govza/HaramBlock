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
  type ByteRangeSource,
  type DecodeJob,
  type DecodedTarget,
  type EncodedSample,
  type InferredSample,
  type Liveness,
  type LookaheadOptions,
  type LookaheadPorts,
  type Playhead,
  type StoredSample,
  type UnreachableReason,
} from '@/utils/lookahead/ports';
import { openProgressiveFile, UnreachableFetchError, type ProgressiveFile } from '@/utils/lookahead/progressiveFile';
import { isUnsafeAt, suspicionThresholdOf } from '@/utils/lookahead/sampleScores';
import { isPersistentIdentity, type PersistentVideoIdentity, type VideoIdentity } from '@/utils/videoIdentity';

export const URGENT_SLACK_SEC = 5;
const MAX_INFLIGHT_INFERENCES = 6;
const MAX_RETAINED_UNITS = 64;
const MAX_UNPUBLISHED_SAMPLES = 2_000;
const REPLAY_BEHIND_US = 30e6;
const REPLAY_AHEAD_US = 300e6;
export const IDENTITY_WAIT_MS = 3_000;

/**
 * A half-open span of media time, in microseconds, whose known samples the reader was last sent.
 */
interface TimeWindowUs {
  startUs: number;
  endUs: number;
}

const replayWindowAround = (playhead: Playhead): TimeWindowUs => {
  const playheadUs = playhead.timeSec * 1e6;
  return { startUs: playheadUs - REPLAY_BEHIND_US, endUs: playheadUs + REPLAY_AHEAD_US };
};

const isWithin = (window: TimeWindowUs, pointUs: number): boolean =>
  pointUs >= window.startUs && pointUs < window.endUs;

/**
 * A span of media the scheduler can sample from: one MSE Analysis Unit, or a whole Progressive Source windowed around
 * the playhead.
 */
export interface PointSource {
  readonly startUs: number;
  readonly endUs: number;
  readonly arrivedAt: number;
  pointsToSample(): number[];
  isDue(pointUs: number): boolean;
  nextBatch(orderedPoints: readonly number[]): number[];
  buildJob(points: readonly number[]): Promise<DecodeJob | null>;
  release(): void;
}

export class SampleScheduler {
  private readonly known = new Map<number, StoredSample>();
  private readonly unsafeAtPoint = new Map<number, boolean>();
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
  private liveness: Liveness;
  private identity: VideoIdentity;
  private identityArrived: ((identity: PersistentVideoIdentity | null) => void) | null = null;
  private unpublished: StoredSample[] = [];
  private replayWindow: TimeWindowUs | null = null;

  constructor(
    private readonly ports: LookaheadPorts,
    private readonly options: LookaheadOptions,
  ) {
    this.liveness = options.liveness;
    this.identity = options.identity;
    this.cacheLoaded = this.loadCache();
  }

  private async loadCache(): Promise<void> {
    const identity = this.liveness === 'live' ? null : await this.awaitIdentity();
    if (identity && this.liveness !== 'live') {
      try {
        const cached = await this.ports.cache.read(identity);
        for (const sample of cached) {
          this.recordKnown(sample);
          this.cachedUnreported.add(sample.pointUs);
        }
        for (const sample of cached) this.ports.events.sample(sample);
        this.replayWindow = replayWindowAround(this.playhead);
      } catch {
        this.ports.events.stat?.({ kind: 'cacheReadFailed' });
      }
    }
    this.cacheReady = true;
    this.planRefinements();
    this.schedulePump();
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  get heldSources(): number {
    return this.sources.length;
  }

  setPlayhead(playhead: Playhead): void {
    this.playhead = playhead;
    this.replayKnownAroundPlayhead();
    this.schedulePump();
  }

  /**
   * Re-sends known samples entering the window around the playhead: the reader's Verdict Timeline
   * is capped and may have evicted them, and they are never inferred again.
   */
  private replayKnownAroundPlayhead(): void {
    if (!this.cacheReady) return;
    const previous = this.replayWindow;
    const next = replayWindowAround(this.playhead);
    this.replayWindow = next;
    for (const sample of this.sortedKnown()) {
      if (!isWithin(next, sample.pointUs) || (previous && isWithin(previous, sample.pointUs))) continue;
      this.ports.events.sample(sample);
    }
  }

  currentPlayhead(): Playhead {
    return this.playhead;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.schedulePump();
  }

  /**
   * Resolves with the session's identity once it is stable or local, or with `null` when it is still unknown after
   * the wait (or the session stopped), so an unidentified session analyses without the cache.
   */
  private awaitIdentity(): Promise<PersistentVideoIdentity | null> {
    if (isPersistentIdentity(this.identity)) return Promise.resolve(this.identity);
    return new Promise(resolve => {
      const timer = setTimeout(() => this.identityArrived?.(null), IDENTITY_WAIT_MS);
      this.identityArrived = identity => {
        clearTimeout(timer);
        this.identityArrived = null;
        resolve(identity);
      };
    });
  }

  setIdentity(identity: VideoIdentity): void {
    if (this.stopped || isPersistentIdentity(this.identity) || !isPersistentIdentity(identity)) return;
    this.identity = identity;
    this.identityArrived?.(identity);
    this.publishHeld();
  }

  setLiveness(liveness: Liveness): void {
    if (this.liveness === 'live' || liveness === 'unknown') return;
    this.liveness = liveness;
    if (liveness === 'live') this.unpublished = [];
    else this.publishHeld();
  }

  private publishableIdentity(): PersistentVideoIdentity | null {
    return this.liveness === 'vod' && isPersistentIdentity(this.identity) ? this.identity : null;
  }

  private publishHeld(): void {
    const identity = this.publishableIdentity();
    if (!identity || this.unpublished.length === 0) return;
    const held = this.unpublished;
    this.unpublished = [];
    this.ports.cache.publish(identity, held);
  }

  private publish(sample: StoredSample): void {
    if (this.liveness === 'live') return;
    const identity = this.publishableIdentity();
    if (identity) this.ports.cache.publish(identity, [sample]);
    else if (this.unpublished.length < MAX_UNPUBLISHED_SAMPLES) this.unpublished.push(sample);
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

  stop(reason?: UnreachableReason): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unpublished = [];
    this.identityArrived?.(null);
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

  private isDue = (pointUs: number): boolean => this.sourceFor(pointUs)?.isDue(pointUs) ?? true;

  private dueWanted(): number[] {
    return [...this.wanted].filter(this.isDue);
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
    this.unsafeAtPoint.set(sample.pointUs, isUnsafeAt(sample, this.options.scoreThreshold));
    this.wanted.delete(sample.pointUs);
  }

  private sortedKnown(): StoredSample[] {
    return [...this.known.values()].sort((a, b) => a.pointUs - b.pointUs);
  }

  private isUnsafe(sample: StoredSample): boolean {
    return this.unsafeAtPoint.get(sample.pointUs) ?? false;
  }

  private isSuspiciousClean(sample: StoredSample): boolean {
    return !this.isUnsafe(sample) && sample.topUnsafeScore >= suspicionThresholdOf(this.options.scoreThreshold);
  }

  private planRefinements(): void {
    const samples = this.sortedKnown();
    samples.forEach((sample, index) => {
      const next = samples[index + 1];
      if (next && this.isUnsafe(sample) !== this.isUnsafe(next)) {
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
    const next = this.dueWanted().sort(this.compareOrder)[0];
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
      this.dueWanted()
        .filter(point => this.sourceFor(point) === source)
        .sort(this.compareOrder),
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
    try {
      for await (const item of this.ports.decoder.decode(job)) {
        if (this.stopped) {
          item.frame.close();
          continue;
        }
        decoded.get(item.target.pointUs)?.frame.close();
        decoded.set(item.target.pointUs, item);
      }
    } catch (error) {
      for (const item of decoded.values()) item.frame.close();
      throw error;
    }
    for (const point of orderedPoints) {
      const item = decoded.get(point);
      decoded.delete(point);
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
    for (const unrequested of decoded.values()) unrequested.frame.close();
  }

  private requestInference(pointUs: number, item: DecodedTarget): Promise<InferredSample> {
    try {
      return this.ports.inference.infer({ pointUs, frame: item.frame, priority: this.priorityFor(pointUs) });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private submitInference(pointUs: number, item: DecodedTarget): void {
    const request = this.requestInference(pointUs, item).finally(() => item.frame.close());
    void this.trackWork(
      request.then(
        inferred => {
          this.inflight.delete(pointUs);
          if (this.stopped) return;
          const sample: StoredSample = { pointUs, ...inferred };
          this.recordKnown(sample);
          this.ports.events.stat?.({ kind: 'analysed', pointUs });
          this.ports.events.sample(sample);
          this.publish(sample);
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
        this.dueWanted().length === 0);
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

  isDue(): boolean {
    return true;
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

/**
 * Per-SourceBuffer analysis state; the cutter survives a session close so a reopened analysis resumes the stream.
 */
interface BufferState {
  cutter: UnitCutter | null;
  chunkGroup: EncodedSample[];
  chunkGroupAnalysed: number;
  chunkConfig: VideoDecoderConfig | null;
}

export type MseBuffers = ReadonlyMap<string, BufferState>;

const bufferStateFor = (mime: string): BufferState => {
  const kind = containerKindOf(mime);
  return { cutter: kind ? createUnitCutter(kind) : null, chunkGroup: [], chunkGroupAnalysed: 0, chunkConfig: null };
};

function resumedBuffers(released: MseBuffers): Map<string, BufferState> {
  const buffers = new Map<string, BufferState>();
  for (const [bufferId, state] of released) {
    buffers.set(bufferId, {
      cutter: state.cutter,
      chunkGroup: [],
      chunkGroupAnalysed: 0,
      chunkConfig: state.chunkConfig,
    });
  }
  return buffers;
}

/**
 * Lookahead Analysis of one MSE source, fed the hook's SourceBuffer messages and sampling the Analysis Units they
 * complete.
 */
export interface MseAnalysis {
  addBuffer(bufferId: string, mime: string): void;
  changeType(bufferId: string, mime: string): void;
  append(bufferId: string, bytes: Uint8Array, timestampOffsetSec: number, discontinuity?: boolean): void;
  appendChunks(bufferId: string, config: VideoDecoderConfig, chunks: readonly EncodedSample[]): void;
  endOfStream(bufferId: string): void;
  removeBuffer(bufferId: string): void;
  setPlayhead(playhead: Playhead): void;
  setVisible(visible: boolean): void;
  setLiveness(liveness: Liveness): void;
  setIdentity(identity: VideoIdentity): void;
  stop(): void;
  releaseBuffers(): MseBuffers;
  heldUnits(): number;
  settled(): Promise<void>;
}

export function createMseAnalysis(
  ports: LookaheadPorts,
  options: LookaheadOptions,
  resumeFrom: MseBuffers = new Map(),
): MseAnalysis {
  const scheduler = new SampleScheduler(ports, options);
  const buffers = resumedBuffers(resumeFrom);
  let arrivals = 0;
  let demuxChain: Promise<void> = Promise.resolve();

  const addUnit = (unit: DemuxedUnit) => {
    arrivals += 1;
    scheduler.addSource(new UnitSource(unit, arrivals));
  };

  const enqueueDemux = (unit: AnalysisUnitBytes) => {
    demuxChain = scheduler.trackWork(
      demuxChain.then(async () => {
        if (scheduler.isStopped) return;
        try {
          addUnit(await demuxUnit(unit));
        } catch {
          ports.events.stat?.({ kind: 'unitDemuxFailed' });
          scheduler.stop('demux');
        }
      }),
    );
  };

  const bufferFor = (bufferId: string): BufferState | undefined => buffers.get(bufferId);

  const analyseChunkGroup = (state: BufferState) => {
    const group = state.chunkGroup;
    const config = state.chunkConfig;
    if (!config || state.chunkGroupAnalysed === group.length) return;
    state.chunkGroupAnalysed = group.length;
    const startUs = Math.min(...group.map(sample => sample.timestampUs));
    const endUs = Math.max(...group.map(sample => sample.timestampUs + sample.durationUs));
    addUnit({ config, packets: [...group], startUs, endUs });
  };

  return {
    addBuffer(bufferId, mime) {
      if (mime.toLowerCase().startsWith('audio/')) return;
      buffers.set(bufferId, bufferStateFor(mime));
    },
    changeType(bufferId, mime) {
      if (!buffers.has(bufferId)) return;
      buffers.set(bufferId, bufferStateFor(mime));
    },
    append(bufferId, bytes, timestampOffsetSec, discontinuity = false) {
      const cutter = bufferFor(bufferId)?.cutter;
      if (!cutter || scheduler.isStopped) return;
      if (discontinuity) cutter.resync();
      for (const unit of cutter.push(bytes, Math.round(timestampOffsetSec * 1e6)).units) enqueueDemux(unit);
    },
    appendChunks(bufferId, config, chunks) {
      const state = bufferFor(bufferId);
      if (!state || scheduler.isStopped) return;
      for (const chunk of chunks) {
        if (chunk.type === 'key') {
          analyseChunkGroup(state);
          state.chunkGroup = [];
          state.chunkGroupAnalysed = 0;
        }
        state.chunkConfig = config;
        state.chunkGroup.push(chunk);
      }
      analyseChunkGroup(state);
    },
    endOfStream(bufferId) {
      const cutter = bufferFor(bufferId)?.cutter;
      if (!cutter || scheduler.isStopped) return;
      for (const unit of cutter.endOfStream().units) enqueueDemux(unit);
    },
    removeBuffer(bufferId) {
      buffers.delete(bufferId);
    },
    setPlayhead: playhead => scheduler.setPlayhead(playhead),
    setVisible: visible => scheduler.setVisible(visible),
    setLiveness: liveness => scheduler.setLiveness(liveness),
    setIdentity: identity => scheduler.setIdentity(identity),
    stop: () => scheduler.stop(),
    releaseBuffers: () => {
      scheduler.stop();
      for (const state of buffers.values()) state.cutter?.resync();
      return buffers;
    },
    heldUnits: () => scheduler.heldSources,
    settled: async () => {
      await demuxChain;
      await scheduler.settled();
    },
  };
}

const DEFAULT_WINDOW_SEC = 60;
/**
 * Lookahead Analysis of a Progressive Source, sampling a window ahead of the playhead with range reads.
 */
export interface ProgressiveAnalysis {
  setPlayhead(playhead: Playhead): void;
  setVisible(visible: boolean): void;
  setLiveness(liveness: Liveness): void;
  setIdentity(identity: VideoIdentity): void;
  stop(): void;
  settled(): Promise<void>;
}

class ProgressiveSource implements PointSource {
  readonly startUs = 0;
  readonly arrivedAt = 0;
  private readonly samplePoints: number[];
  private inWindow: (pointUs: number) => boolean = () => false;

  constructor(
    private readonly scheduler: SampleScheduler,
    private readonly file: ProgressiveFile,
    private readonly windowUs: number,
  ) {
    this.samplePoints = file.gops.flatMap(gop => gop.points);
    this.refreshWindow();
  }

  get endUs(): number {
    return this.file.durationUs + 1;
  }

  refreshWindow(): void {
    if (!this.scheduler.isVisible()) {
      this.inWindow = () => false;
      return;
    }
    const playheadUs = this.scheduler.currentPlayhead().timeSec * 1e6;
    const startUs = this.samplePoints.findLast(point => point <= playheadUs) ?? 0;
    const endUs = playheadUs + this.windowUs;
    this.inWindow = pointUs => pointUs >= startUs && pointUs < endUs;
  }

  pointsToSample(): number[] {
    return this.samplePoints.filter(this.inWindow);
  }

  isDue(pointUs: number): boolean {
    return this.inWindow(pointUs);
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
    source.refreshWindow();
    scheduler.refreshWanted(source);
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
    setLiveness: liveness => scheduler.setLiveness(liveness),
    setIdentity: identity => scheduler.setIdentity(identity),
    stop: () => scheduler.stop(),
    settled: async () => {
      await opening;
      await scheduler.settled();
    },
  };
}
