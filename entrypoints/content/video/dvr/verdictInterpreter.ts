import {
  COVERAGE_MAX_GAP_SEC,
  VerdictTimeline,
  type VerdictEntry,
} from '@/entrypoints/content/video/dvr/verdictTimeline';
import {
  TRANSIENT_HIT_CONFIG,
  type SampleVerdict,
  type TransientHitConfig,
} from '@/entrypoints/content/video/session/machine';

export type VerdictLookup = { kind: 'unsafe'; entries: VerdictEntry[] } | { kind: 'clean' } | { kind: 'none' };

export const BRIDGE_HORIZON_SEC = 3;

export type RunResolution = 'suppressed' | 'confident' | 'long' | 'late';

export interface ResolvedRun {
  resolution: RunResolution;
  runLength: number;
  topProbability: number;
}

export interface VerdictInterpreterOptions {
  config?: TransientHitConfig;
  onRunResolved?: (run: ResolvedRun) => void;
}

interface UnsafeRun {
  firstIndex: number;
  lastIndex: number;
  overLimit: boolean;
  confident: boolean;
  closedByClean: boolean;
}

type RunDecision = 'hit' | 'suppressed' | 'undecided';

interface HitJudgement {
  run: UnsafeRun | null;
  inherited: RunDecision;
  hit: boolean;
}

export class VerdictInterpreter {
  private readonly timeline = new VerdictTimeline();
  private readonly config: TransientHitConfig;
  private readonly onRunResolved: (run: ResolvedRun) => void;
  private readonly confidentEntries = new WeakSet<VerdictEntry>();
  private readonly latchedHits = new WeakMap<VerdictEntry, boolean>();

  constructor(options: VerdictInterpreterOptions = {}) {
    this.config = options.config ?? TRANSIENT_HIT_CONFIG;
    this.onRunResolved = options.onRunResolved ?? (() => {});
  }

  record(entry: VerdictEntry, scoreThreshold: number): SampleVerdict {
    if (entry.unsafe && topProbability(entry) >= this.confidentProbability(scoreThreshold)) {
      this.confidentEntries.add(entry);
    }
    const index = this.timeline.add(entry);
    if (entry.unsafe) return this.isHitBeforeClosing(index) ? 'unsafe' : 'tentative';
    const confirmsPrevious = this.timeline.at(index - 1) !== undefined && !this.isHit(index - 1);
    return confirmsPrevious ? 'confirmedClean' : 'clean';
  }

  coverageAheadOf(fromSec: number): number {
    return this.timeline.coverageAheadOf(fromSec);
  }

  verdictFor(mediaTime: number, bridgeHorizonSec = BRIDGE_HORIZON_SEC): VerdictLookup {
    const after = this.timeline.indexAfter(mediaTime);
    const previous = this.timeline.at(after - 1);
    const next = this.timeline.at(after);
    const nextIsHit = next ? this.isHit(after) : false;

    if (!previous) {
      if (next && !nextIsHit) return { kind: 'clean' };
      return { kind: 'none' };
    }

    const nextNear = next && nextIsHit && next.timestampSec - mediaTime <= bridgeHorizonSec ? next : null;

    if (this.latchPresentedHit(after - 1)) return unsafeLookup(previous, nextNear);

    const before = this.timeline.at(after - 2);
    if (before && this.latchPresentedHit(after - 2) && (!next || nextIsHit)) return unsafeLookup(before, nextNear);
    return { kind: 'clean' };
  }

  private confidentProbability(scoreThreshold: number): number {
    return Math.min(scoreThreshold * this.config.confidenceCoefficient, this.config.confidenceCap);
  }

  private isHit(index: number): boolean {
    return this.judgeHit(index)?.hit ?? false;
  }

  private latchPresentedHit(index: number): boolean {
    const judgement = this.judgeHit(index);
    if (!judgement) return false;
    const { run, inherited, hit } = judgement;
    if (run && decisionOf(hit) !== inherited) {
      this.latchRun(run, index, hit);
      this.reportResolution(run, index);
    }
    return hit;
  }

  private judgeHit(index: number): HitJudgement | null {
    const entry = this.timeline.at(index);
    if (!entry?.unsafe) return null;
    if (this.latchedHits.get(entry) === true) return { run: null, inherited: 'hit', hit: true };

    const run = this.unsafeRunAround(index);
    const inherited = this.latchedDecisionIn(run);
    const hit = run.overLimit || run.confident || isHitDecision(inherited, run);
    return { run, inherited, hit };
  }

  private reportResolution(run: UnsafeRun, presentedIndex: number): void {
    const startsRun = presentedIndex === run.firstIndex && !this.isAdjacentUnsafe(run.firstIndex - 1, run.firstIndex);
    if (run.overLimit && !startsRun) return;
    this.onRunResolved({
      resolution: resolutionOf(run),
      runLength: run.lastIndex - run.firstIndex + 1,
      topProbability: this.topProbabilityOf(run),
    });
  }

  private topProbabilityOf(run: UnsafeRun): number {
    return this.membersOf(run).reduce((top, member) => Math.max(top, topProbability(member)), 0);
  }

  private isHitBeforeClosing(index: number): boolean {
    const run = this.unsafeRunAround(index);
    return run.overLimit || run.confident || this.latchedDecisionIn(run) === 'hit';
  }

  private latchedDecisionIn(run: UnsafeRun): RunDecision {
    const latched = this.membersOf(run).map(member => this.latchedHits.get(member));
    if (latched.includes(true)) return 'hit';
    if (latched.includes(false)) return 'suppressed';
    return 'undecided';
  }

  private latchRun(run: UnsafeRun, presentedIndex: number, hit: boolean): void {
    if (run.overLimit) {
      const presented = this.timeline.at(presentedIndex);
      if (presented) this.latchedHits.set(presented, hit);
      return;
    }
    for (const member of this.membersOf(run)) this.latchedHits.set(member, hit);
  }

  private membersOf(run: Pick<UnsafeRun, 'firstIndex' | 'lastIndex'>): VerdictEntry[] {
    const members: VerdictEntry[] = [];
    for (let i = run.firstIndex; i <= run.lastIndex; i++) {
      const member = this.timeline.at(i);
      if (member) members.push(member);
    }
    return members;
  }

  private unsafeRunAround(index: number): UnsafeRun {
    const limit = this.config.maxSuppressedRun;
    let firstIndex = index;
    while (index - firstIndex < limit && this.isAdjacentUnsafe(firstIndex - 1, firstIndex)) firstIndex--;
    let lastIndex = index;
    while (lastIndex - index < limit && this.isAdjacentUnsafe(lastIndex + 1, lastIndex)) lastIndex++;

    const confident = this.membersOf({ firstIndex, lastIndex }).some(member => this.confidentEntries.has(member));
    const closing = this.timeline.at(lastIndex + 1);
    return {
      firstIndex,
      lastIndex,
      overLimit: lastIndex - firstIndex + 1 > limit,
      confident,
      closedByClean: closing !== undefined && !closing.unsafe && this.areAdjacent(lastIndex, lastIndex + 1),
    };
  }

  private isAdjacentUnsafe(candidateIndex: number, anchorIndex: number): boolean {
    return this.timeline.at(candidateIndex)?.unsafe === true && this.areAdjacent(candidateIndex, anchorIndex);
  }

  private areAdjacent(indexA: number, indexB: number): boolean {
    const a = this.timeline.at(indexA);
    const b = this.timeline.at(indexB);
    return a !== undefined && b !== undefined && Math.abs(b.timestampSec - a.timestampSec) <= COVERAGE_MAX_GAP_SEC;
  }
}

function unsafeLookup(anchor: VerdictEntry, nextNear: VerdictEntry | null): VerdictLookup {
  return { kind: 'unsafe', entries: nextNear ? [anchor, nextNear] : [anchor] };
}

function decisionOf(hit: boolean): RunDecision {
  return hit ? 'hit' : 'suppressed';
}

function isHitDecision(inherited: RunDecision, run: UnsafeRun): boolean {
  if (inherited === 'undecided') return !run.closedByClean;
  return inherited === 'hit';
}

function resolutionOf(run: UnsafeRun): RunResolution {
  if (run.confident) return 'confident';
  if (run.overLimit) return 'long';
  if (!run.closedByClean) return 'late';
  return 'suppressed';
}

function topProbability(entry: VerdictEntry): number {
  return entry.predictions.reduce((top, prediction) => Math.max(top, prediction.probability), 0);
}
