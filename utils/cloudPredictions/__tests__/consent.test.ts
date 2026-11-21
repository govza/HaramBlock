import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

const environment = vi.hoisted(() => ({ isChrome: true }));
vi.mock('@/utils/constants/environment', () => ({
  get IS_CHROME() {
    return environment.isChrome;
  },
}));

import {
  agree,
  decline,
  declineIfDataCollectionRevoked,
  getCloudPredictionsStatus,
  getConsent,
  getReporterId,
  isOn,
  onCloudPredictionsChange,
  optionsSectionOf,
} from '@/utils/cloudPredictions';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const permissionRequest = vi.fn<(permissions: unknown) => Promise<boolean>>();
const permissionContains = vi.fn<(permissions: unknown) => Promise<boolean>>();

const useBrowser = (browserName: 'chrome' | 'firefox') => {
  environment.isChrome = browserName === 'chrome';
};

const namesBothDataTypes = (permissions: unknown) => {
  const named = (permissions as { data_collection?: string[] }).data_collection ?? [];
  return ['browsingActivity', 'websiteContent'].every(dataType => named.includes(dataType));
};

const firefoxGrants = (granted: boolean) => {
  const answer = (permissions: unknown) => Promise.resolve(granted && namesBothDataTypes(permissions));
  permissionRequest.mockImplementation(answer);
  permissionContains.mockImplementation(answer);
};

beforeEach(() => {
  fakeBrowser.reset();
  fakeBrowser.permissions.request = permissionRequest;
  fakeBrowser.permissions.contains = permissionContains;
  useBrowser('chrome');
});

describe('consent state', () => {
  it('starts unanswered and off, with no Reporter ID', async () => {
    await expect(getConsent()).resolves.toBe('unanswered');
    await expect(isOn()).resolves.toBe(false);
    await expect(getReporterId()).resolves.toBeUndefined();
  });

  it('agree turns it on and creates a random Reporter ID', async () => {
    await expect(agree()).resolves.toBe(true);

    await expect(getConsent()).resolves.toBe('agreed');
    await expect(isOn()).resolves.toBe(true);
    expect(await getReporterId()).toMatch(UUID_PATTERN);
  });

  it('decline before ever agreeing turns it off and creates no Reporter ID', async () => {
    await decline();

    await expect(getConsent()).resolves.toBe('declined');
    await expect(isOn()).resolves.toBe(false);
    await expect(getReporterId()).resolves.toBeUndefined();
  });

  it('keeps the same Reporter ID across off and on', async () => {
    await agree();
    const firstId = await getReporterId();

    await decline();
    await expect(getReporterId()).resolves.toBe(firstId);

    await agree();
    await expect(getReporterId()).resolves.toBe(firstId);
  });

  it('never asks Chrome for a data-collection permission', async () => {
    await agree();

    expect(permissionRequest).not.toHaveBeenCalled();
  });
});

describe('Firefox data-collection permissions', () => {
  beforeEach(() => useBrowser('firefox'));

  it('agree turns it on when Firefox grants both data types', async () => {
    firefoxGrants(true);

    await expect(agree()).resolves.toBe(true);

    await expect(getConsent()).resolves.toBe('agreed');
    await expect(isOn()).resolves.toBe(true);
  });

  it('a refused prompt leaves an unanswered state unchanged and creates no Reporter ID', async () => {
    firefoxGrants(false);

    await expect(agree()).resolves.toBe(false);

    await expect(getConsent()).resolves.toBe('unanswered');
    await expect(isOn()).resolves.toBe(false);
    await expect(getReporterId()).resolves.toBeUndefined();
  });

  it('a refused prompt leaves a declined state declined', async () => {
    await decline();
    firefoxGrants(false);

    await agree();

    await expect(getConsent()).resolves.toBe('declined');
  });

  it('is off while agreed when a data type was revoked in about:addons', async () => {
    firefoxGrants(true);
    await agree();

    permissionContains.mockResolvedValue(false);

    await expect(getConsent()).resolves.toBe('agreed');
    await expect(isOn()).resolves.toBe(false);
  });

  it('granting a revoked data type back in about:addons does not switch it on again', async () => {
    firefoxGrants(true);
    await agree();

    permissionContains.mockResolvedValue(false);
    await declineIfDataCollectionRevoked();
    firefoxGrants(true);

    await expect(getConsent()).resolves.toBe('declined');
    await expect(isOn()).resolves.toBe(false);
  });

  it('keeps the agreement while both data types stay granted', async () => {
    firefoxGrants(true);
    await agree();

    await declineIfDataCollectionRevoked();

    await expect(getConsent()).resolves.toBe('agreed');
  });

  it('a revoked data type shows as off after having agreed', async () => {
    firefoxGrants(true);
    await agree();
    permissionContains.mockResolvedValue(false);

    const status = await getCloudPredictionsStatus();

    expect(optionsSectionOf(status).state).toBe('off');
  });
});

describe('section state', () => {
  it('is never agreed while no Reporter ID exists', () => {
    expect(optionsSectionOf({ consent: 'unanswered', isOn: false })).toEqual({ state: 'neverAgreed' });
    expect(optionsSectionOf({ consent: 'declined', isOn: false })).toEqual({ state: 'neverAgreed' });
  });

  it('is on when every gate passes', () => {
    expect(optionsSectionOf({ consent: 'agreed', isOn: true, reporterId: 'id' })).toEqual({
      state: 'on',
      reporterId: 'id',
    });
  });

  it('is off once a Reporter ID exists and a gate fails', () => {
    expect(optionsSectionOf({ consent: 'declined', isOn: false, reporterId: 'id' })).toEqual({
      state: 'off',
      reporterId: 'id',
    });
    expect(optionsSectionOf({ consent: 'agreed', isOn: false, reporterId: 'id' })).toEqual({
      state: 'off',
      reporterId: 'id',
    });
  });

  it('reads the stored state, effective switch and Reporter ID together', async () => {
    await agree();

    await expect(getCloudPredictionsStatus()).resolves.toEqual({
      consent: 'agreed',
      isOn: true,
      reporterId: await getReporterId(),
    });
  });
});

describe('change subscription', () => {
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  it('notifies on agree and on decline', async () => {
    const listener = vi.fn();
    onCloudPredictionsChange(listener);

    await agree();
    await settle();
    expect(listener).toHaveBeenCalled();

    listener.mockClear();
    await decline();
    await settle();
    expect(listener).toHaveBeenCalled();
  });

  it('stops reporting once unsubscribed', async () => {
    const listener = vi.fn();
    const unsubscribe = onCloudPredictionsChange(listener);
    unsubscribe();

    await agree();
    await settle();

    expect(listener).not.toHaveBeenCalled();
  });
});
