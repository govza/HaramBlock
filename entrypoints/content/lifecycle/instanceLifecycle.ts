import { logger } from '@/utils/logger';

const log = logger.withTag('InstanceLifecycle');

export interface InstanceLifecyclePorts {
  /** Distinguishes a dead extension context from a transient transport failure. */
  isContextValid: () => boolean;
  /** Fires when a successor instance claims the page (extension reload/update). Returns unsubscribe. */
  onSuperseded: (listener: () => void) => () => void;
  /** Fires when the transport reports permanently failed channel establishment. Returns unsubscribe. */
  onTransportDead: (listener: () => void) => () => void;
  /** Disposes all video sessions and stops the media pipeline and DOM observation. */
  stopPipeline: () => void;
  /** Strips pre-verdict styling still applied to page elements. */
  removeInitialStyling: () => void;
}

/**
 * Detects that this content-script instance has been orphaned — superseded by
 * a successor after an extension reload/update, or cut off by disable/removal —
 * and fails open exactly once through the teardown ports. Detection must not
 * rely on extension APIs: an orphan's context is invalidated and they throw.
 */
export class InstanceLifecycle {
  private tornDown = false;
  private readonly stopListening: (() => void)[] = [];

  constructor(private readonly ports: InstanceLifecyclePorts) {}

  get isTornDown(): boolean {
    return this.tornDown;
  }

  start(): void {
    this.stopListening.push(this.ports.onSuperseded(() => this.teardown('superseded by a newer instance')));
    this.stopListening.push(
      this.ports.onTransportDead(() => {
        // A dead channel with a live context is the service-worker idle kill;
        // the transport re-establishes lazily and this instance is not orphaned.
        if (this.ports.isContextValid()) return;
        this.teardown('extension context invalidated');
      }),
    );
  }

  private teardown(reason: string): void {
    if (this.tornDown) return;
    this.tornDown = true;
    log.warn(`Instance orphaned (${reason}); failing open`);
    for (const unsubscribe of this.stopListening) this.runStep(unsubscribe);
    this.stopListening.length = 0;
    this.runStep(() => this.ports.stopPipeline());
    this.runStep(() => this.ports.removeInitialStyling());
  }

  /** A step that dies (e.g. mid-crash orphan state) must not block the rest of fail-open. */
  private runStep(step: () => void): void {
    try {
      step();
    } catch (error) {
      log.error('Teardown step failed:', error);
    }
  }
}
