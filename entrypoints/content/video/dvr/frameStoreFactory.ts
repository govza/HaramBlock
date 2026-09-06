/**
 * Per-DVR-run frame store selection (docs/VIDEO_PROCESSING.md): every session
 * starts on a raw ring immediately (startDvr is synchronous), and upgrades to
 * the WebCodecs-encoded ring when the async capability probe passes — the
 * upgrade flushes a few warm-up frames, equivalent to a seek re-warm the
 * presenter already tolerates. A codec error mid-run swaps back to a fresh raw
 * ring and marks the session webcodecs-ineligible for its lifetime. Selection
 * is re-evaluated at each DVR (re)start, never mid-run (errors excepted).
 */

import {
  decodedFrameConverterFactoryFor,
  type DecodedFrameConverterFactory,
} from '@/entrypoints/content/video/dvr/decodedFrameConverter';
import {
  EncodedFrameRing,
  createWebCodecsPair,
  encoderConfigFor,
  type EncodedRingCodecs,
} from '@/entrypoints/content/video/dvr/encodedFrameRing';
import { RawFrameRing } from '@/entrypoints/content/video/dvr/rawFrameRing';
import { getLogger } from '@/utils/telemetry';

import type {
  DvrCaptureFrame,
  DvrCaptureMode,
  DvrFrameStore,
  DvrStoreKind,
  PresentableFrame,
} from '@/entrypoints/content/video/dvr/frameStore';

const log = getLogger('frameStoreFactory');

/**
 * Firefox has no GPU path from a decoded VideoFrame to a canvas: every draw
 * converts the frame's YUV planes to RGB on the calling thread (~16 ms per
 * 1080p frame, docs/VIDEO_PROCESSING.md). Converting in a worker moves that
 * off the presenter's rAF tick. Chrome's draw is ~0.5 ms, so nothing to move.
 */
const platformConverterFactory = decodedFrameConverterFactoryFor(import.meta.env.FIREFOX);

/**
 * Conservative cap on concurrent hardware encoder sessions; sessions beyond it
 * get raw rings. NVIDIA consumer drivers historically cap NVENC at 3-8
 * concurrent sessions — measure before raising, and record numbers and
 * hardware here.
 */
export const ENCODED_SESSION_CAP = 4;

/**
 * Debug flag for the encoded ring: on in dev builds for measurement, off in
 * production until the rollout flips it (spec: rollout steps 2-3).
 */
let encodedRingEnabled = Boolean(import.meta.env.DEV);

export function setEncodedDvrRingEnabled(enabled: boolean): void {
  encodedRingEnabled = enabled;
}

export function isEncodedDvrRingEnabled(): boolean {
  return encodedRingEnabled;
}

/** Pure selection rule: probe result × concurrency cap × prior error × flag. */
export function selectStoreKind(input: {
  enabled: boolean;
  probeSupported: boolean;
  activeEncodedSessions: number;
  encodedIneligible: boolean;
}): DvrStoreKind {
  return selectStoreReason(input) === 'encoded' ? 'encoded' : 'raw';
}

export function selectStoreReason(input: {
  enabled: boolean;
  probeSupported: boolean;
  activeEncodedSessions: number;
  encodedIneligible: boolean;
}): DvrStoreReason {
  const { enabled, probeSupported, activeEncodedSessions, encodedIneligible } = input;
  if (!enabled) return 'disabled';
  if (encodedIneligible) return 'ineligible';
  if (!probeSupported) return 'webcodecs_unsupported';
  return activeEncodedSessions < ENCODED_SESSION_CAP ? 'encoded' : 'session_cap';
}

/** Global counter of live encoded sessions; injectable for factory tests. */
export interface EncodedSessionSlots {
  active(): number;
  acquire(): boolean;
  release(): void;
}

function createSlots(cap: number): EncodedSessionSlots {
  let active = 0;
  return {
    active: () => active,
    acquire: () => {
      if (active >= cap) return false;
      active++;
      return true;
    },
    release: () => {
      active = Math.max(0, active - 1);
    },
  };
}

const globalSlots = createSlots(ENCODED_SESSION_CAP);

export type EncodedSupportProbe = (width: number, height: number) => Promise<boolean>;

/**
 * Chrome treats `prefer-hardware` as a preference, so probing with it rejects
 * only configs that would silently software-encode on the main thread.
 * Firefox maps `prefer-hardware` to require-hardware and its release builds
 * expose no hardware encoder at all (about:support lists every codec as
 * "Hardware Encoding: Unsupported"), so the same probe fails unconditionally.
 * Its software encoder runs off the main thread in a media process at ~5 ms
 * wall per 1080p frame, far cheaper than the raw ring's ~21 ms main-thread
 * canvas capture, so Firefox probes with no preference.
 */
export function probeHardwarePreference(isFirefox: boolean): HardwareAcceleration {
  return isFirefox ? 'no-preference' : 'prefer-hardware';
}

const webCodecsProbe: EncodedSupportProbe = async (width, height) => {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') return false;
  try {
    const hardwareAcceleration = probeHardwarePreference(import.meta.env.FIREFOX);
    const config = { ...encoderConfigFor(width, height), hardwareAcceleration };
    const encoderSupport = await VideoEncoder.isConfigSupported(config);
    if (!encoderSupport.supported) return false;
    const decoderSupport = await VideoDecoder.isConfigSupported({
      codec: config.codec,
      hardwareAcceleration,
    });
    return decoderSupport.supported === true;
  } catch {
    return false;
  }
};

/** Probe verdicts are per-geometry and stable for the page's lifetime. */
const probeCache = new Map<string, Promise<boolean>>();

function cachedProbe(probe: EncodedSupportProbe, width: number, height: number): Promise<boolean> {
  const key = `${width}x${height}`;
  let result = probeCache.get(key);
  if (!result) {
    result = probe(width, height);
    probeCache.set(key, result);
  }
  return result;
}

export type DvrStoreReason =
  | 'encoded'
  | 'probing'
  | 'disabled'
  | 'ineligible'
  | 'session_cap'
  | 'webcodecs_unsupported'
  | 'released_before_probe'
  | 'codec_error';

export interface SessionFrameStore extends DvrFrameStore {
  /** Which implementation currently backs the store (budget demand, debug attribute). */
  kind(): DvrStoreKind;
  /** Why the store is on its current backing (lifecycle log attribute). */
  selectionReason(): DvrStoreReason;
  /**
   * Force the raw fallback mid-run for failures the store cannot see itself —
   * e.g. `new VideoFrame(video)` throwing SecurityError on a tainted source
   * that the display-only canvas capture path still handles. No-op when
   * already raw.
   */
  demoteToRaw(): void;
}

export interface CreateDvrFrameStoreOptions {
  maxDurationSec: number;
  maxBytes: number;
  /** Best-known frame geometry at DVR start; the probe keys off it. */
  probeWidth: number;
  probeHeight: number;
  /** Session already failed WebCodecs once: raw for its lifetime. */
  encodedIneligible: boolean;
  /** Fired on the first codec error, before the swap back to raw. */
  onEncodedError: () => void;
  /** Fired whenever the backing implementation changes (upgrade or error fallback). */
  onKindChange?: (kind: DvrStoreKind) => void;
  /** Test seams. */
  codecs?: EncodedRingCodecs;
  probe?: EncodedSupportProbe;
  slots?: EncodedSessionSlots;
  createConverter?: DecodedFrameConverterFactory | null;
}

export function createDvrFrameStore(options: CreateDvrFrameStoreOptions): SessionFrameStore {
  const slots = options.slots ?? globalSlots;
  const probe = options.probe ?? webCodecsProbe;
  const createConverter = options.createConverter === undefined ? platformConverterFactory : options.createConverter;
  const store = new SwappableFrameStore(
    new RawFrameRing(options.maxDurationSec, options.maxBytes),
    options.maxDurationSec,
    options.maxBytes,
    options.onKindChange,
  );

  const preSelection = selectStoreReason({
    enabled: encodedRingEnabled,
    probeSupported: true, // probe result pending; re-checked below
    activeEncodedSessions: slots.active(),
    encodedIneligible: options.encodedIneligible,
  });
  store.setSelectionReason(preSelection === 'encoded' ? 'probing' : preSelection);
  if (preSelection === 'encoded') {
    void cachedProbe(probe, options.probeWidth, options.probeHeight)
      .then(supported => {
        if (!supported) {
          store.setSelectionReason('webcodecs_unsupported');
          return;
        }
        if (store.isReleased()) {
          store.setSelectionReason('released_before_probe');
          return;
        }
        if (!slots.acquire()) {
          store.setSelectionReason('session_cap');
          return;
        }
        const encoded = new EncodedFrameRing({
          maxDurationSec: store.currentMaxDurationSec(),
          maxBytes: store.currentMaxBytes(),
          codecs: options.codecs ?? createWebCodecsPair(),
          convertDecoded: createConverter?.() ?? null,
          onFatalError: () => {
            options.onEncodedError();
            if (!store.isReleased() && store.kind() === 'encoded') {
              store.setSelectionReason('codec_error');
              store.swapTo(new RawFrameRing(store.currentMaxDurationSec(), store.currentMaxBytes()), null);
            }
          },
        });
        store.setSelectionReason('encoded');
        store.swapTo(encoded, () => slots.release());
      })
      .catch((error: unknown) => {
        store.setSelectionReason('webcodecs_unsupported');
        log.debug('dvr.encoded_ring_probe.failed', { error });
      });
  }
  return store;
}

/**
 * Delegating store whose backing implementation can be exchanged mid-run
 * (raw → encoded on probe success, encoded → raw on codec error). A swap
 * releases the old store — the presenter re-warms exactly as after a seek.
 */
class SwappableFrameStore implements SessionFrameStore {
  private current: DvrFrameStore;
  private currentDispose: (() => void) | null = null;
  /** Misses accumulated by earlier backings, so the counter stays monotonic across swaps. */
  private coveredMissBase = 0;
  private flushBase = 0;
  private released = false;
  private reason: DvrStoreReason = 'probing';
  private maxDurationSec: number;
  private maxBytes: number;

  constructor(
    initial: RawFrameRing,
    maxDurationSec: number,
    maxBytes: number,
    private readonly onKindChange?: (kind: DvrStoreKind) => void,
  ) {
    this.current = initial;
    this.maxDurationSec = maxDurationSec;
    this.maxBytes = maxBytes;
  }

  kind(): DvrStoreKind {
    return this.current.captureMode === 'video-frame' ? 'encoded' : 'raw';
  }

  selectionReason(): DvrStoreReason {
    return this.reason;
  }

  setSelectionReason(reason: DvrStoreReason): void {
    this.reason = reason;
  }

  isReleased(): boolean {
    return this.released;
  }

  demoteToRaw(): void {
    if (this.released || this.kind() === 'raw') return;
    this.reason = 'ineligible';
    this.swapTo(new RawFrameRing(this.maxDurationSec, this.maxBytes), null);
  }

  currentMaxDurationSec(): number {
    return this.maxDurationSec;
  }

  currentMaxBytes(): number {
    return this.maxBytes;
  }

  swapTo(next: DvrFrameStore, dispose: (() => void) | null): void {
    if (this.released) {
      next.release();
      dispose?.();
      return;
    }
    this.coveredMissBase += this.current.coveredMisses();
    this.flushBase += this.current.flushes() + 1;
    this.current.release();
    this.currentDispose?.();
    this.current = next;
    this.currentDispose = dispose;
    next.setLimits(this.maxDurationSec, this.maxBytes);
    this.onKindChange?.(this.kind());
  }

  get captureMode(): DvrCaptureMode {
    return this.current.captureMode;
  }

  push(frame: DvrCaptureFrame, mediaTime: number): boolean {
    return this.current.push(frame, mediaTime);
  }

  frameAt(mediaTime: number): PresentableFrame | null {
    return this.current.frameAt(mediaTime);
  }

  coveredMisses(): number {
    return this.coveredMissBase + this.current.coveredMisses();
  }

  flushes(): number {
    return this.flushBase + this.current.flushes();
  }

  lookaheadFrames(): number {
    return this.current.lookaheadFrames();
  }

  spanSec(): number {
    return this.current.spanSec();
  }

  oldestTime(): number | null {
    return this.current.oldestTime();
  }

  newestTime(): number | null {
    return this.current.newestTime();
  }

  bytes(): number {
    return this.current.bytes();
  }

  setLimits(maxDurationSec: number, maxBytes: number): void {
    this.maxDurationSec = maxDurationSec;
    this.maxBytes = maxBytes;
    this.current.setLimits(maxDurationSec, maxBytes);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.current.release();
    this.currentDispose?.();
    this.currentDispose = null;
  }
}
