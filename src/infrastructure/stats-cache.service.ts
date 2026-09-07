import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';

const FILE_STATS_KEY = 'filetransfer:superadmin:file-stats:v1';

@Injectable()
export class StatsCacheService {
  private readonly logger = new Logger(StatsCacheService.name);
  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Cache timeout')), 250);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async fileStats<T>(load: () => Promise<T>): Promise<T> {
    try {
      const cached = await this.bounded(this.cache.get<T>(FILE_STATS_KEY));
      if (cached !== undefined && cached !== null) return cached;
    } catch {
      this.logger.warn('Statistics cache unavailable; reading database');
    }
    const result = await load();
    try {
      await this.bounded(this.cache.set(FILE_STATS_KEY, result, 15000));
    } catch {
      this.logger.warn('Statistics cache write failed');
    }
    return result;
  }

  async invalidate(): Promise<void> {
    try {
      await this.bounded(this.cache.del(FILE_STATS_KEY));
    } catch {
      this.logger.warn('Statistics cache invalidation failed; TTL will expire');
    }
  }
}
