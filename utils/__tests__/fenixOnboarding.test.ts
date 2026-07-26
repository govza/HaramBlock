import { describe, expect, it } from 'vitest';

import { findOnboardingButton } from '@/tests/e2e/utils/fenix-onboarding.js';

describe('findOnboardingButton', () => {
  it('finds the Fenix label node even when click handling belongs to its parent', () => {
    const xml = `
      <hierarchy>
        <node text="" package="org.mozilla.fenix" clickable="true" bounds="[0,0][1080,200]">
          <node
            text="Continue"
            package="org.mozilla.fenix"
            clickable="false"
            bounds="[120,40][960,160]"
          />
        </node>
      </hierarchy>
    `;

    expect(findOnboardingButton(xml)).toEqual({
      label: 'Continue',
      x: 540,
      y: 100,
    });
  });
});
