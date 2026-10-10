import {
  createMseAnalysis,
  createProgressiveAnalysis,
  type MseAnalysis,
  type MseBuffers,
  type ProgressiveAnalysis,
} from '@/utils/lookahead/analysis';

import type {
  ByteRangeSource,
  DecoderPort,
  InferencePort,
  LookaheadEvents,
  SampleCachePort,
  UnreachableReason,
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
  live: boolean;
  analysis: MseAnalysis | null;
  released: MseBuffers;
}

type Analysis = MseAnalysis | ProgressiveAnalysis;

function replayInto(analysis: MseAnalysis, message: Exclude<HookMessage, { t: 'source' | 'overflow' }>): void {
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
    case 'removeBuffer':
      analysis.removeBuffer(String(message.bufferId));
      break;
  }
}

export class LookaheadHost {
  private readonly sources = new Map<number, HookedSource>();
  private readonly sessions = new Map<string, Analysis>();
  private readonly waiters = new Map<string, (sourceId: number) => void>();
  private readonly latestOpens = new Map<string, OpenAnalysis>();

  constructor(private readonly ports: HostPorts) {}

  handleHook(message: HookMessage): void {
    if (message.t === 'source') {
      this.sources.set(message.sourceId, {
        objectUrl: message.objectUrl,
        live: message.live,
        analysis: null,
        released: new Map(),
      });
      this.waiters.get(message.objectUrl)?.(message.sourceId);
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
    const lookaheadPorts = {
      decoder: this.ports.decoder(open),
      inference: this.ports.inference(open),
      cache: this.ports.cache(open),
      events: this.events(open),
    };
    const options = { live: open.live, suspicionThreshold: open.suspicionThreshold };
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
    const analysis = createMseAnalysis(lookaheadPorts, { ...options, live: options.live || source.live }, previous);
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
      const timer = setTimeout(() => {
        this.waiters.delete(objectUrl);
        resolve(null);
      }, SOURCE_WAIT_MS);
      this.waiters.set(objectUrl, sourceId => {
        clearTimeout(timer);
        this.waiters.delete(objectUrl);
        resolve(sourceId);
      });
    });
  }
}
