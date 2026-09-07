import { StatsCacheService } from './stats-cache.service';

describe('statistics cache', () => {
  it('serves repeated reads from cache and reloads after invalidation', async () => {
    const values = new Map();
    const cache = {
      get: jest.fn(async (key) => values.get(key)),
      set: jest.fn(async (key, value, _ttl: number) => {
        values.set(key, value);
      }),
      del: jest.fn(async (key) => values.delete(key)),
    };
    const service = new StatsCacheService(cache as any);
    const load = jest
      .fn()
      .mockResolvedValueOnce({ total: 1 })
      .mockResolvedValueOnce({ total: 2 });
    expect(await service.fileStats(load)).toEqual({ total: 1 });
    expect(await service.fileStats(load)).toEqual({ total: 1 });
    expect(load).toHaveBeenCalledTimes(1);
    await service.invalidate();
    expect(await service.fileStats(load)).toEqual({ total: 2 });
    expect(cache.set.mock.calls[0][2]).toBe(15000);
  });

  it('still returns database results if Redis is down', async () => {
    const cache = {
      get: jest.fn().mockRejectedValue(new Error('offline')),
      set: jest.fn().mockRejectedValue(new Error('offline')),
      del: jest.fn().mockRejectedValue(new Error('offline')),
    };
    const service = new StatsCacheService(cache as any);
    expect(await service.fileStats(async () => ({ total: 5 }))).toEqual({
      total: 5,
    });
    await expect(service.invalidate()).resolves.toBeUndefined();
  });
});
