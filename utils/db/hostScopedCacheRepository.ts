import Dexie from 'dexie';

import { BaseRepository } from '@/utils/db/baseRepository';
import { isCacheDisabled } from '@/utils/db/cacheAvailability';
import { getEffectiveHostname } from '@/utils/hostnameUtil';

export interface IHostCacheSummary {
  hostname: string;
  count: number;
}

export interface IHostCachePage<T> {
  records: T[];
  total: number;
  page: number;
}

export abstract class HostScopedCacheRepository<
  T extends { hostname: string; timestamp: number },
> extends BaseRepository<T, string> {
  async listHostSummaries(): Promise<IHostCacheSummary[]> {
    if (isCacheDisabled) return [];
    const hostnames = (await this.table.orderBy('hostname').uniqueKeys()).map(String);
    const summaries = await Promise.all(
      hostnames.map(async hostname => ({ hostname, count: await this.countByHostname(hostname) })),
    );
    return summaries.sort((a, b) => b.count - a.count);
  }

  async countByHostname(hostname: string): Promise<number> {
    if (isCacheDisabled) return 0;
    return this.whereHostname(hostname).count();
  }

  async findNewestPageByHostname(hostname: string, page: number, pageSize: number): Promise<IHostCachePage<T>> {
    if (isCacheDisabled) return { records: [], total: 0, page: 0 };
    const total = await this.countByHostname(hostname);
    const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);
    const clampedPage = Math.min(page, lastPage);
    const effectiveHostname = getEffectiveHostname(hostname);
    const records = await this.table
      .where('[hostname+timestamp]')
      .between([effectiveHostname, Dexie.minKey], [effectiveHostname, Dexie.maxKey])
      .reverse()
      .offset(clampedPage * pageSize)
      .limit(pageSize)
      .toArray();
    return { records, total, page: clampedPage };
  }

  async deleteByHostname(hostname: string): Promise<number> {
    if (isCacheDisabled) return 0;
    return this.whereHostname(hostname).delete();
  }

  async clear(): Promise<void> {
    if (isCacheDisabled) return;
    await this.table.clear();
  }

  private whereHostname(hostname: string) {
    return this.table.where('hostname').equals(getEffectiveHostname(hostname));
  }
}
