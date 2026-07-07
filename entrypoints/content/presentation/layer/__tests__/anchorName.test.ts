import { describe, expect, it } from 'vitest';

import {
  assertAnchorNameOn,
  composeAnchorName,
  restoreAnchorNameOn,
  type IInlineStyle,
  type IPriorAnchor,
} from '@/entrypoints/content/presentation/layer/anchorName';

interface FakeStyle extends IInlineStyle {
  value: string;
  priority: string;
}

const fakeStyle = (value = '', priority = ''): FakeStyle => ({
  value,
  priority,
  getPropertyValue(property) {
    return property === 'anchor-name' ? this.value : '';
  },
  getPropertyPriority(property) {
    return property === 'anchor-name' ? this.priority : '';
  },
  setProperty(property, newValue, newPriority = '') {
    if (property !== 'anchor-name') return;
    this.value = newValue;
    this.priority = newPriority;
  },
  removeProperty(property) {
    const old = this.value;
    if (property === 'anchor-name') {
      this.value = '';
      this.priority = '';
    }
    return old;
  },
});

const OURS = '--haramblock-anchor-1';

describe('composeAnchorName', () => {
  it('appends our name to the site list (anchor-name is a list property)', () => {
    expect(composeAnchorName(OURS, { value: '--site-tooltip', priority: '' })).toBe(`--site-tooltip, ${OURS}`);
  });

  it('treats empty and `none` priors as no list (`none` is not a valid list member)', () => {
    expect(composeAnchorName(OURS, undefined)).toBe(OURS);
    expect(composeAnchorName(OURS, { value: '', priority: '' })).toBe(OURS);
    expect(composeAnchorName(OURS, { value: 'none', priority: '' })).toBe(OURS);
  });
});

describe('assertAnchorNameOn', () => {
  it('sets our name with important on a clean element and captures the empty prior', () => {
    const style = fakeStyle();
    const prior = assertAnchorNameOn(style, OURS, undefined);
    expect(style.value).toBe(OURS);
    expect(style.priority).toBe('important');
    expect(prior).toEqual({ value: '', priority: '' });
  });

  it('preserves a site anchor name by composing instead of clobbering', () => {
    const style = fakeStyle('--site-tooltip');
    const prior = assertAnchorNameOn(style, OURS, undefined);
    expect(style.value).toBe(`--site-tooltip, ${OURS}`);
    expect(style.priority).toBe('important');
    expect(prior).toEqual({ value: '--site-tooltip', priority: '' });
  });

  it('re-asserts after a framework wiped the style attribute, without recapturing our own value', () => {
    const style = fakeStyle('--site-tooltip');
    const prior = assertAnchorNameOn(style, OURS, undefined);
    style.value = ''; // framework re-render rewrote the style attribute
    style.priority = '';
    const again = assertAnchorNameOn(style, OURS, prior);
    expect(style.value).toBe(`--site-tooltip, ${OURS}`);
    expect(again).toEqual(prior);
  });

  it('is a no-op write when the composed value is already asserted', () => {
    const style = fakeStyle();
    const prior = assertAnchorNameOn(style, OURS, undefined);
    let writes = 0;
    const originalSet = style.setProperty.bind(style);
    style.setProperty = (...args) => {
      writes += 1;
      originalSet(...args);
    };
    assertAnchorNameOn(style, OURS, prior);
    expect(writes).toBe(0);
  });

  it('upgrades a value-equal but non-important declaration (fail-closed against site rules)', () => {
    const style = fakeStyle(OURS, '');
    assertAnchorNameOn(style, OURS, { value: '', priority: '' });
    expect(style.priority).toBe('important');
  });
});

describe('restoreAnchorNameOn', () => {
  const asserted = (initial = '', priority = ''): { style: FakeStyle; prior: IPriorAnchor } => {
    const style = fakeStyle(initial, priority);
    const prior = assertAnchorNameOn(style, OURS, undefined);
    return { style, prior };
  };

  it('removes the property when the element had no inline anchor-name', () => {
    const { style, prior } = asserted();
    restoreAnchorNameOn(style, OURS, prior);
    expect(style.value).toBe('');
    expect(style.priority).toBe('');
  });

  it('restores the site declaration, including its priority', () => {
    const { style, prior } = asserted('--site-tooltip', 'important');
    restoreAnchorNameOn(style, OURS, prior);
    expect(style.value).toBe('--site-tooltip');
    expect(style.priority).toBe('important');
  });

  it('restores an explicit `none` prior', () => {
    const { style, prior } = asserted('none');
    restoreAnchorNameOn(style, OURS, prior);
    expect(style.value).toBe('none');
  });

  it('leaves a value the site overwrote after our assert', () => {
    const { style, prior } = asserted();
    style.value = '--site-rewrote-this';
    restoreAnchorNameOn(style, OURS, prior);
    expect(style.value).toBe('--site-rewrote-this');
  });

  it('is a no-op when assert never ran (undefined prior, foreign value)', () => {
    const style = fakeStyle('--site-tooltip');
    restoreAnchorNameOn(style, OURS, undefined);
    expect(style.value).toBe('--site-tooltip');
  });
});
