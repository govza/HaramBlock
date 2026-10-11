import {
  createMseAnalysis,
  createProgressiveAnalysis,
  type MseAnalysis,
  type MseBuffers,
  type ProgressiveAnalysis,
} from '@/utils/lookahead/analysis';
import {
  combinedLiveness,
  type ByteRangeSource,
  type DecoderPort,
  type InferencePort,
  type Liveness,
  type LookaheadEvents,
  type SampleCachePort,
  type UnreachableReason,
} from '@/utils/lookahead/ports';

import type { ContentToHost, HookCommand, HookMessage, HostToContent, OpenAnalysis } from '@/utils/lookahead/protocol';

const SOURCE_WAIT_MS = 3_000;

export interface HostPorts {
  decoder(open: OpenAnalysis): DecoderPort;
  inference(open: OpenAnalysis): InferencePort;
  cache(open: OpenAnalysis): SampleCachePort;
  rangeSource(url: string): ByteRangeSource;
  send(message: HostToContent): void;
  toHook(command: HookCommand): void;
}

interface HookedSource {
  objectUrl: string;
  liveness: Liveness;
  analysis: MseAnalysis | null;
  released: MseBuffers;
}

type Analysis = MseAnalysis | ProgressiveAnalysis;

function replayInto(
  analysis: MseAnalysis,
  message: Exclude<HookMessage, { t: 'source' | 'liveness' | 'overflow' }>,
): void {
  switch (message.t) {
    case 'buffer':
      analysis.addBuffer(String(message.bufferId), message.mime);
      break;
    case 'changeType':
      analysis.changeType(String(message.bufferId), message.mime);
      break;
    case 'append':
      analysis.append(
        String(message.bufferId),
        new Uint8Array(message.bytes),
        message.timestampOffset,
        message.discontinuity,
      );
      break;
    case 'chunks':
      analysis.appendChunks(
        String(message.bufferId),
        message.config,
        message.chunks.map(chunk => ({ ...chunk, data: new Uint8Array(chunk.data) })),
      );
      break;
    case 'endOfStream':
      analysis.endOfStream(String(message.bufferId));
      break;
    case 'removeBuffer':
      analysis.removeBuffer(String(message.bufferId));
      break;
  }
}

export class LookaheadHost {
  private readonly sources = new Map<number, HookedSource>();
  private readonly sessions = new Map<string, Analysis>();
  private readonly waiters = new Map<string, Set<(sourceId: number) => void>>();
  private readonly latestOpens = new Map<string, OpenAnalysis>();
  private readonly contentLiveness = new Map<string, Liveness>();

  constructor(private readonly ports: HostPorts) {}

  handleHook(message: HookMessage): void {
    if (message.t === 'source') {
      this.sources.set(message.sourceId, {
        objectUrl: message.objectUrl,
        liveness: message.liveness,
        analysis: null,
        released: new Map(),
      });
      for (const notify of this.waiters.get(message.objectUrl) ?? []) notify(message.sourceId);
      return;
    }
    if (message.t === 'liveness') {
      const source = this.sources.get(message.sourceId);
      if (!source) return;
      source.liveness = message.liveness;
      if (source.analysis) this.applyLiveness(source.analysis);
      return;
    }
    const analysis = this.sources.get(message.sourceId)?.analysis;
    if (!analysis) return;
    if (message.t !== 'overflow') {
      replayInto(analysis, message);
      return;
    }
    const sessionId = this.sessionOf(analysis);
    if (sessionId) this.unreachable(sessionId, 'overflow');
  }

  private sessionOf(analysis: Analysis): string | undefined {
    return [...this.sessions].find(([, candidate]) => candidate === analysis)?.[0];
  }

  private livenessOf(sessionId: string, source: HookedSource | undefined): Liveness {
    return combinedLiveness(this.contentLiveness.get(sessionId) ?? 'unknown', source?.liveness ?? 'vod');
  }

  private applyLiveness(analysis: Analysis): void {
    const sessionId = this.sessionOf(analysis);
    if (!sessionId) return;
    const source = [...this.sources.values()].find(candidate => candidate.analysis === analysis);
    analysis.setLiveness(this.livenessOf(sessionId, source));
  }

  handleContent(message: ContentToHost): void {
    switch (message.t) {
      case 'open':
        void this.open(message);
        break;
      case 'playhead':
        this.sessions.get(message.sessionId)?.setPlayhead(message.playhead);
        break;
      case 'visible':
        this.sessions.get(message.sessionId)?.setVisible(message.visible);
        break;
      case 'liveness': {
        if (!this.contentLiveness.has(message.sessionId)) break;
        this.contentLiveness.set(message.sessionId, message.liveness);
        const analysis = this.sessions.get(message.sessionId);
        if (analysis) this.applyLiveness(analysis);
        break;
      }
      case 'close':
        this.close(message.sessionId);
        break;
      case 'inferResult':
      case 'cacheSamples':
        break;
    }
  }

  closeAll(): void {
    for (const sessionId of [...this.sessions.keys()]) this.close(sessionId);
  }

  private close(sessionId: string): void {
    this.latestOpens.delete(sessionId);
    this.contentLiveness.delete(sessionId);
    const analysis = this.sessions.get(sessionId);
    if (!analysis) return;
    this.sessions.delete(sessionId);
    analysis.stop();
    for (const [sourceId, source] of this.sources) {
      if (source.analysis !== analysis) continue;
      source.released = source.analysis.releaseBuffers();
      source.analysis = null;
      this.ports.toHook({ t: 'drop', sourceId });
    }
  }

  private events(open: OpenAnalysis): LookaheadEvents {
    const { sessionId } = open;
    return {
      sample: sample => this.ports.send({ t: 'sample', sessionId, sample }),
      unreachable: reason => this.unreachable(sessionId, reason),
      stat: stat => this.ports.send({ t: 'stat', sessionId, stat }),
    };
  }

  private unreachable(sessionId: string, reason: UnreachableReason): void {
    this.close(sessionId);
    this.ports.send({ t: 'unreachable', sessionId, reason });
  }

  private async open(open: OpenAnalysis): Promise<void> {
    this.close(open.sessionId);
    this.latestOpens.set(open.sessionId, open);
    this.contentLiveness.set(open.sessionId, open.liveness);
    const lookaheadPorts = {
      decoder: this.ports.decoder(open),
      inference: this.ports.inference(open),
      cache: this.ports.cache(open),
      events: this.events(open),
    };
    const options = { liveness: open.liveness, scoreThreshold: open.scoreThreshold };
    if (open.tap.kind === 'progressive') {
      const bytes = this.ports.rangeSource(open.tap.url);
      let reported = false;
      const reportReachableOnFirstRange: ByteRangeSource = {
        size: async () => {
          const size = await bytes.size();
          if (!reported && this.sessions.get(open.sessionId) === analysis) {
            reported = true;
            this.ports.send({ t: 'reachable', sessionId: open.sessionId, tap: 'progressive' });
          }
          return size;
        },
        read: (start, end) => bytes.read(start, end),
      };
      const analysis = createProgressiveAnalysis(lookaheadPorts, options, reportReachableOnFirstRange);
      this.latestOpens.delete(open.sessionId);
      this.sessions.set(open.sessionId, analysis);
      return;
    }
    const sourceId = await this.sourceFor(open.tap.objectUrl);
    if (this.latestOpens.get(open.sessionId) !== open) return;
    this.latestOpens.delete(open.sessionId);
    if (sourceId === null) {
      this.ports.send({ t: 'unreachable', sessionId: open.sessionId, reason: 'hook' });
      return;
    }
    const source = this.sources.get(sourceId);
    if (!source) return;
    const previous = source.analysis?.releaseBuffers() ?? source.released;
    const analysis = createMseAnalysis(
      lookaheadPorts,
      { ...options, liveness: this.livenessOf(open.sessionId, source) },
      previous,
    );
    source.released = new Map();
    source.analysis = analysis;
    this.sessions.set(open.sessionId, analysis);
    this.ports.send({ t: 'reachable', sessionId: open.sessionId, tap: 'mse' });
    this.ports.toHook({ t: 'want', sourceId });
  }

  private sourceFor(objectUrl: string): Promise<number | null> {
    for (const [sourceId, source] of this.sources) {
      if (source.objectUrl === objectUrl) return Promise.resolve(sourceId);
    }
    return new Promise(resolve => {
      const waiting = this.waiters.get(objectUrl) ?? new Set();
      this.waiters.set(objectUrl, waiting);
      const settle = (sourceId: number | null) => {
        clearTimeout(timer);
        waiting.delete(settle);
        if (waiting.size === 0 && this.waiters.get(objectUrl) === waiting) this.waiters.delete(objectUrl);
        resolve(sourceId);
      };
      const timer = setTimeout(() => settle(null), SOURCE_WAIT_MS);
      waiting.add(settle);
    });
  }
}
