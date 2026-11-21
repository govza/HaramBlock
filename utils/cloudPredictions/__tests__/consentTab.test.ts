import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

vi.mock('@/utils/constants/environment', () => ({ IS_CHROME: true }));

import { agree, decline, openConsentTabIfDue, shouldOpenConsentTab } from '@/utils/cloudPredictions';

describe('shouldOpenConsentTab', () => {
  it.each([
    { reason: 'install', consent: 'unanswered', alreadyShown: false, expected: true },
    { reason: 'update', consent: 'unanswered', alreadyShown: false, expected: true },
    { reason: 'update', consent: 'unanswered', alreadyShown: true, expected: false },
    { reason: 'install', consent: 'unanswered', alreadyShown: true, expected: false },
    { reason: 'update', consent: 'declined', alreadyShown: false, expected: false },
    { reason: 'update', consent: 'agreed', alreadyShown: false, expected: false },
    { reason: 'chrome_update', consent: 'unanswered', alreadyShown: false, expected: false },
    { reason: 'shared_module_update', consent: 'unanswered', alreadyShown: false, expected: false },
  ] as const)('$reason with $consent consent, shown before: $alreadyShown -> $expected', decision => {
    expect(shouldOpenConsentTab(decision)).toBe(decision.expected);
  });
});

describe('openConsentTabIfDue', () => {
  const createTab = vi.fn();

  beforeEach(() => {
    fakeBrowser.reset();
    createTab.mockResolvedValue({ id: 1 });
    fakeBrowser.tabs.create = createTab;
  });

  it('opens the consent page on install', async () => {
    await openConsentTabIfDue('install');

    expect(createTab).toHaveBeenCalledTimes(1);
    expect(createTab).toHaveBeenCalledWith({ url: expect.stringMatching(/\/consent\.html$/) as string });
  });

  it('opens it once only, across install and later updates', async () => {
    await openConsentTabIfDue('install');
    await openConsentTabIfDue('update');
    await openConsentTabIfDue('update');

    expect(createTab).toHaveBeenCalledTimes(1);
  });

  it('opens it on the introducing update of an install that never saw it', async () => {
    await openConsentTabIfDue('update');

    expect(createTab).toHaveBeenCalledTimes(1);
  });

  it('does not open it once the user has answered', async () => {
    await decline();
    await openConsentTabIfDue('update');
    await agree();
    await openConsentTabIfDue('update');

    expect(createTab).not.toHaveBeenCalled();
  });

  it('tries again on the next update when opening the tab failed', async () => {
    createTab.mockRejectedValueOnce(new Error('no window'));

    await expect(openConsentTabIfDue('install')).rejects.toThrow('no window');
    await openConsentTabIfDue('update');

    expect(createTab).toHaveBeenCalledTimes(2);
  });
});
