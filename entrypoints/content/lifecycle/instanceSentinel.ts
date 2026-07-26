import { generateNonce } from '@/utils/nonce';

const INSTANCE_SENTINEL_ATTR = 'data-haramblock-instance';

export type SupersedeSignal = (listener: () => void) => () => void;

/**
 * Stamp this instance's nonce onto the page and return a supersede signal.
 * The sentinel is pure DOM on purpose: when a successor stamps its own nonce,
 * every earlier instance observes the change even though its extension context
 * is already invalidated and every extension API throws. Instances stamp
 * exactly once at startup, so a foreign nonce always means a newer instance.
 * A stripped sentinel (site interference) is ignored — re-stamping could make
 * an older instance look like a successor to the live one.
 */
export const claimInstanceSentinel = (): SupersedeSignal => {
  const sentinel = document.documentElement;
  const nonce = generateNonce();
  sentinel.setAttribute(INSTANCE_SENTINEL_ATTR, nonce);

  return listener => {
    const observer = new MutationObserver(() => {
      const current = sentinel.getAttribute(INSTANCE_SENTINEL_ATTR);
      if (current === nonce || current === null) return;
      observer.disconnect();
      listener();
    });
    observer.observe(sentinel, { attributes: true, attributeFilter: [INSTANCE_SENTINEL_ATTR] });
    return () => observer.disconnect();
  };
};
