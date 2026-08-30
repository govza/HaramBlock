/**
 * DOM markers stamped on attached videos. The registry owns their lifecycle
 * (stamped on attach, removed on teardown); the predecessor sweep
 * (lifecycle/predecessorSweep.ts) selects on them to find videos a crashed
 * predecessor instance never released.
 */
export const SESSION_ID_ATTR = 'data-hb-session-id';
export const SESSION_SRC_ATTR = 'data-hb-src';
