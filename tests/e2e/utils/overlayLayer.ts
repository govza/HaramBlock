import { Selectors } from '../constants/index.js';

/**
 * Helpers for asserting on the extension's overlay hosts. Masks render inside the
 * layer host's (open) shadow root and the quick-toggle button inside the UI host's,
 * so plain page selectors cannot see them.
 */

/**
 * Count host elements matching `selector` that are actually visible. Slots stay in
 * the DOM while hidden (display: none) for occluded/zero-rect elements and for masks
 * the user toggled off, so visibility — not existence — is the meaningful assertion.
 */
export const countVisibleInLayer = async (
  selector: string,
  hostSelector: string = Selectors.OVERLAY_HOST,
): Promise<number> =>
  browser.execute(
    (hostSel: string, sel: string) => {
      const host = globalThis.document.querySelector(hostSel);
      if (!host?.shadowRoot) return 0;
      let visible = 0;
      for (const el of host.shadowRoot.querySelectorAll<HTMLElement>(sel)) {
        if (el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null) visible += 1;
      }
      return visible;
    },
    hostSelector,
    selector,
  );

/** A WebdriverIO element inside a host's shadow root (host must exist). */
export const getLayerElement = async (
  selector: string,
  hostSelector: string = Selectors.OVERLAY_HOST,
): Promise<WebdriverIO.Element> => {
  const host = await $(hostSelector);
  return host.shadow$(selector);
};
