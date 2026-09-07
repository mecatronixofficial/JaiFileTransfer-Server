import 'dotenv/config';
import './infrastructure/dns.bootstrap';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { CleanupWorkerModule } from './worker/cleanup-worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(CleanupWorkerModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
}
void bootstrap();
