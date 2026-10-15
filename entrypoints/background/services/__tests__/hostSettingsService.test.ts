import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HostSettingsService } from '@/entrypoints/background/services/hostSettingsService';

import type { IHostSettings } from '@/utils/types';

const findByHostname = vi.fn<(hostname: string) => Promise<IHostSettings>>();

vi.mock('@/utils/db/hostSettingsRepository', () => ({
  createHostSettingsRepository: () => ({ findByHostname }),
}));

const settingsFor = (hostname: string, strictness: number) => ({ hostname, strictness }) as IHostSettings;

describe('HostSettingsService', () => {
  beforeEach(() => {
    findByHostname.mockReset();
    findByHostname.mockImplementation(hostname => Promise.resolve(settingsFor(hostname, 0.5)));
  });

  it('reads each hostname from storage once', async () => {
    const service = new HostSettingsService();

    await service.getHostSettings('example.com');
    await service.getHostSettings('example.com');

    expect(findByHostname).toHaveBeenCalledTimes(1);
  });

  it('shares one read between concurrent callers', async () => {
    const service = new HostSettingsService();

    await Promise.all([service.getHostSettings('example.com'), service.getHostSettings('example.com')]);

    expect(findByHostname).toHaveBeenCalledTimes(1);
  });

  it('keeps incognito and regular settings apart', async () => {
    const service = new HostSettingsService();

    await service.getHostSettings('example.com');
    await service.getHostSettings('example.com', true);

    expect(findByHostname).toHaveBeenCalledTimes(2);
  });

  it('re-reads every hostname after invalidate', async () => {
    const service = new HostSettingsService();
    await service.getHostSettings('example.com');
    findByHostname.mockImplementation(hostname => Promise.resolve(settingsFor(hostname, 0.9)));

    service.invalidate();

    await expect(service.getHostSettings('example.com')).resolves.toMatchObject({ strictness: 0.9 });
  });

  it('does not cache a failed read', async () => {
    const service = new HostSettingsService();
    findByHostname.mockRejectedValueOnce(new Error('db closed'));

    await expect(service.getHostSettings('example.com')).rejects.toThrow('db closed');

    await expect(service.getHostSettings('example.com')).resolves.toMatchObject({ hostname: 'example.com' });
  });
});
