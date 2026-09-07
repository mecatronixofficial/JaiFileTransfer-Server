import {
  CleanupProcessor,
  CleanupSchedule,
  redisConnection,
} from './cleanup-worker.module';

describe('cleanup worker', () => {
  it('uses one shared schedule and global concurrency across worker processes', async () => {
    const queue = {
      setGlobalConcurrency: jest.fn(),
      upsertJobScheduler: jest.fn(),
    };
    await new CleanupSchedule(
      queue as any,
      { get: () => undefined } as any,
    ).onModuleInit();
    expect(queue.setGlobalConcurrency).toHaveBeenCalledWith(1);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'expired-files',
      { pattern: '0 0 * * *', tz: 'Asia/Kolkata' },
      expect.objectContaining({
        opts: expect.objectContaining({
          attempts: 5,
          backoff: { type: 'exponential', delay: 60000 },
        }),
      }),
    );
  });

  it('propagates failures for retry and invalidates partially changed statistics', async () => {
    const files = {
      permanentlyDeleteExpired: jest
        .fn()
        .mockRejectedValue(new Error('storage offline')),
    };
    const stats = { invalidate: jest.fn() };
    const processor = new CleanupProcessor(
      files as any,
      { get: () => 7 } as any,
      stats as any,
    );
    await expect(
      processor.process({ name: 'delete-expired-files' } as any),
    ).rejects.toThrow('storage offline');
    expect(stats.invalidate).toHaveBeenCalledTimes(1);
  });

  it('parses TLS, credentials, and Redis database', () => {
    expect(
      redisConnection('rediss://worker:p%40ss@localhost:6380/2'),
    ).toMatchObject({
      host: 'localhost',
      port: 6380,
      username: 'worker',
      password: 'p@ss',
      db: 2,
      tls: {},
    });
    expect(() => redisConnection('https://localhost')).toThrow();
  });
});
