/**
 * Inline `anchor-name` bookkeeping for mask slots (see overlayLayer.ts). Pure over a
 * minimal style surface so the compose/assert/restore logic is unit-testable without
 * a DOM (the repo's test environment is node).
 */

/** Minimal inline-style surface the bookkeeping needs; CSSStyleDeclaration satisfies it. */
export interface IInlineStyle {
  getPropertyValue(property: string): string;
  getPropertyPriority(property: string): string;
  setProperty(property: string, value: string, priority?: string): void;
  removeProperty(property: string): string;
}

/** The element's own inline `anchor-name` declaration from before our first assert. */
export interface IPriorAnchor {
  value: string;
  priority: string;
}

/**
 * `anchor-name` is a comma-separated LIST: our name is appended to the element's own
 * inline value rather than replacing it, so site UI anchored to the element
 * (tooltips, popovers) keeps working while it is masked. `none` and the empty string
 * contribute nothing (`none` is not a valid list member).
 */
export const composeAnchorName = (anchorName: string, prior?: IPriorAnchor): string =>
  prior?.value && prior.value !== 'none' ? `${prior.value}, ${anchorName}` : anchorName;

/**
 * Asserts our anchor name on an element's inline style — composed with the element's
 * own value, `important` so site rules can't outrank it. The prior declaration is
 * captured on the FIRST assert only and returned for the caller to store: a re-assert
 * (framework re-renders rewrite style attributes) must restore the composed value
 * without mistaking it for the site's own.
 */
export const assertAnchorNameOn = (
  style: IInlineStyle,
  anchorName: string,
  prior: IPriorAnchor | undefined,
): IPriorAnchor => {
  const captured = prior ?? {
    value: style.getPropertyValue('anchor-name'),
    priority: style.getPropertyPriority('anchor-name'),
  };
  const composed = composeAnchorName(anchorName, captured);
  if (style.getPropertyValue('anchor-name') !== composed || style.getPropertyPriority('anchor-name') !== 'important') {
    style.setProperty('anchor-name', composed, 'important');
  }
  return captured;
};

/**
 * Undoes our inline `anchor-name` unless the site has overwritten it since the last
 * assert: restores the captured prior declaration, or removes the property when the
 * element had none.
 */
export const restoreAnchorNameOn = (style: IInlineStyle, anchorName: string, prior?: IPriorAnchor): void => {
  if (style.getPropertyValue('anchor-name') !== composeAnchorName(anchorName, prior)) return;
  if (prior?.value) {
    style.setProperty('anchor-name', prior.value, prior.priority);
  } else {
    style.removeProperty('anchor-name');
  }
};
