import { Test } from '@nestjs/testing';
import { HealthModule } from './health.module';
import { MongooseHealthIndicator } from '@nestjs/terminus';
import { VersioningType } from '@nestjs/common';

describe('health routes on Express 5', () => {
  it('keeps health unversioned and returns 503 when MongoDB is unavailable', async () => {
    let connected = true;
    const module = await Test.createTestingModule({ imports: [HealthModule] })
      .overrideProvider(MongooseHealthIndicator)
      .useValue({
        pingCheck: jest.fn(async () => {
          return { mongodb: { status: connected ? 'up' : 'down' } };
        }),
      })
      .compile();
    const app = module.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['health', 'health/ready'] });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.listen(0, '127.0.0.1');
    try {
      const base = await app.getUrl();
      expect((await fetch(`${base}/health`)).status).toBe(200);
      expect((await fetch(`${base}/health/ready`)).status).toBe(200);
      connected = false;
      expect((await fetch(`${base}/health/ready`)).status).toBe(503);
      expect((await fetch(`${base}/health`)).status).toBe(200);
    } finally {
      await app.close();
    }
  });
});
