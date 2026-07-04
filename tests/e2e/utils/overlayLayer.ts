import { Selectors } from '../constants/index.js';

/**
 * Helpers for asserting on the extension's overlay layer. Masks and the quick-toggle
 * button render inside the layer host's (open) shadow root, so plain page selectors
 * cannot see them.
 */

/**
 * Count layer elements matching `selector` that are actually visible. Slots stay in
 * the DOM while hidden (display: none) for occluded/zero-rect elements and for masks
 * the user toggled off, so visibility — not existence — is the meaningful assertion.
 */
export const countVisibleInLayer = async (selector: string): Promise<number> =>
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
    Selectors.OVERLAY_HOST,
    selector,
  );

/** A WebdriverIO element inside the layer's shadow root (host must exist). */
export const getLayerElement = async (selector: string): Promise<WebdriverIO.Element> => {
  const host = await $(Selectors.OVERLAY_HOST);
  return host.shadow$(selector);
};
