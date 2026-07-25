/**
 * An orphaned content script (extension reloaded, updated, disabled, or
 * removed while the page stays open) keeps running with an invalidated
 * context: extension APIs throw or lose their identity. The probe must never
 * throw — it is exactly what orphans call.
 */
export const isExtensionContextValid = (): boolean => {
  try {
    return typeof browser.runtime?.id === 'string';
  } catch {
    return false;
  }
};
