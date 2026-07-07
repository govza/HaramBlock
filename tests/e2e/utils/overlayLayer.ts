import { Selectors } from '../constants/index.js';

/**
 * Helpers for asserting on the extension's overlay hosts. Mask slots are light-DOM
 * children of the layer host (anchor positioning cannot resolve names across a shadow
 * boundary); the quick-toggle button lives inside the UI host's shadow root.
 */

/**
 * Count host elements matching `selector` that are actually visible. Slots stay in
 * the DOM while hidden (display: none) for zero-rect elements and for masks
 * the user toggled off, so visibility — not existence — is the meaningful assertion.
 */
export const countVisibleInLayer = async (
  selector: string,
  hostSelector: string = Selectors.OVERLAY_HOST,
): Promise<number> =>
  browser.execute(
    (hostSel: string, sel: string) => {
      const host = globalThis.document.querySelector(hostSel);
      if (!host) return 0;
      const scope: ParentNode = host.shadowRoot ?? host;
      let visible = 0;
      for (const el of scope.querySelectorAll<HTMLElement>(sel)) {
        if (el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null) visible += 1;
      }
      return visible;
    },
    hostSelector,
    selector,
  );

/** A WebdriverIO element inside a host (shadow root when present, light DOM otherwise). */
export const getLayerElement = async (
  selector: string,
  hostSelector: string = Selectors.OVERLAY_HOST,
): Promise<WebdriverIO.Element> => {
  const host = await $(hostSelector);
  const hasShadow = await browser.execute(
    (hostSel: string) => Boolean(globalThis.document.querySelector(hostSel)?.shadowRoot),
    hostSelector,
  );
  return hasShadow ? host.shadow$(selector) : host.$(selector);
};
