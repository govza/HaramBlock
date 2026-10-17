import { BRIDGE_HORIZON_SEC, COVERAGE_MAX_GAP_SEC } from '@/entrypoints/content/video/maskTiming';
import {
  VerdictTimeline,
  type MediaExtent,
  type VerdictEntry,
} from '@/entrypoints/content/video/timeline/verdictTimeline';
import { PRE_MASK_LEAD_SEC } from '@/utils/lookahead/lattice';

export type VerdictLookup = { kind: 'unsafe'; entries: VerdictEntry[] } | { kind: 'clean' } | { kind: 'none' };

/**
 * Mode-dependent rules for a Verdict Interpreter lookup.
 */
export interface VerdictForOptions {
  bridgeHorizonSec?: number;
  holdUntilConfirmedClean?: boolean;
}

export class VerdictInterpreter {
  private readonly timeline = new VerdictTimeline();

  record(entry: VerdictEntry, playheadSec?: number): void {
    this.timeline.add(entry, playheadSec);
  }

  coverageAheadOf(fromSec: number, media: MediaExtent): number {
    return this.timeline.coverageAheadOf(fromSec, media);
  }

  verdictFor(mediaTime: number, options: VerdictForOptions = {}): VerdictLookup {
    const bridgeHorizonSec = options.bridgeHorizonSec ?? BRIDGE_HORIZON_SEC;
    const holdUntilConfirmedClean = options.holdUntilConfirmedClean ?? false;
    const after = this.timeline.indexAfter(mediaTime);
    const behind = this.timeline.at(after - 1);
    const before = this.timeline.at(after - 2);
    const next = this.timeline.at(after);
    const nextContinuesCoverage = this.areAdjacent(after - 1, after);
    const heldAtFrontier =
      holdUntilConfirmedClean && !nextContinuesCoverage && (behind?.unsafe === true || before?.unsafe === true);
    const withinGap = behind !== undefined && mediaTime - behind.timestampSec <= COVERAGE_MAX_GAP_SEC;
    const previous = withinGap || heldAtFrontier ? behind : undefined;

    if (!previous) {
      if (next && !next.unsafe && next.timestampSec - mediaTime <= COVERAGE_MAX_GAP_SEC) return { kind: 'clean' };
      return { kind: 'none' };
    }

    const nextNear = next?.unsafe && next.timestampSec - mediaTime <= bridgeHorizonSec ? next : null;

    if (previous.unsafe) return unsafeLookup(previous, nextNear);
    const cleanUnconfirmed = !nextContinuesCoverage || next?.unsafe === true;
    if (holdUntilConfirmedClean && before?.unsafe && cleanUnconfirmed) return unsafeLookup(before, nextNear);
    if (next?.unsafe && next.timestampSec - mediaTime <= PRE_MASK_LEAD_SEC && nextContinuesCoverage) {
      return { kind: 'unsafe', entries: [next] };
    }
    return { kind: 'clean' };
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
