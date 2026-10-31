import { getLogger } from '@/utils/telemetry';

const log = getLogger('InstanceLifecycle');

/**
 * Hooks the content-script instance lifecycle uses to tear the page work down once its context is dead, a successor
 * instance claims the page (extension reload/update), or the transport gives up on the channel. The context check is
 * what tells a dead context apart from a transient transport failure.
 */
export interface InstanceLifecyclePorts {
  isContextValid: () => boolean;
  onSuperseded: (listener: () => void) => () => void;
  onTransportDead: (listener: () => void) => () => void;
  stopPipeline: () => void;
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
    log.warn('instance.orphaned', { reason });
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
      log.error('instance.teardown_step.failed', { error });
    }
  }
}
