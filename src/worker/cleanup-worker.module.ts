import { Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule, InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { RuntimeModule } from '../infrastructure/runtime.module';
import { StatsCacheService } from '../infrastructure/stats-cache.service';
import { FilesModule } from '../files/files.module';
import { FilesService } from '../files/files.service';

const CLEANUP_QUEUE = 'filetransfer-cleanup';

export function redisConnection(raw: string) {
  const url = new URL(raw);
  if (!['redis:', 'rediss:'].includes(url.protocol))
    throw new Error('REDIS_URL must use redis:// or rediss://');
  const db = Number(url.pathname.slice(1) || 0);
  if (!Number.isInteger(db) || db < 0)
    throw new Error('Invalid Redis database');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    db,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

@Injectable()
export class CleanupSchedule implements OnModuleInit {
  constructor(
    @InjectQueue(CLEANUP_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}
  async onModuleInit() {
    await this.queue.setGlobalConcurrency(1);
    await this.queue.upsertJobScheduler(
      'expired-files',
      {
        pattern: this.config.get<string>('cron.deleteSchedule') ?? '0 0 * * *',
        tz: this.config.get<string>('CRON_TIMEZONE') ?? 'Asia/Kolkata',
      },
      {
        name: 'delete-expired-files',
        data: {},
        opts: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 60000 },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      },
    );
  }
}

@Processor(CLEANUP_QUEUE, { concurrency: 1 })
export class CleanupProcessor extends WorkerHost {
  private readonly logger = new Logger(CleanupProcessor.name);
  constructor(
    private readonly files: FilesService,
    private readonly config: ConfigService,
    private readonly stats: StatsCacheService,
  ) {
    super();
  }
  async process(job: Job) {
    if (job.name !== 'delete-expired-files')
      throw new Error('Unknown cleanup job');
    const days = Number(this.config.get('files.retentionDays') ?? 7);
    if (!Number.isInteger(days) || days < 1)
      throw new Error('SOFT_DELETE_DAYS must be a positive integer');
    try {
      const deleted = await this.files.permanentlyDeleteExpired(days);
      this.logger.log({ jobId: job.id, deleted }, 'Cleanup completed');
      return { deleted };
    } finally {
      await this.stats.invalidate();
    }
  }
}

@Module({
  imports: [
    RuntimeModule,
    FilesModule,
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: redisConnection(config.getOrThrow<string>('REDIS_URL')),
      }),
    }),
    BullModule.registerQueue({ name: CLEANUP_QUEUE }),
  ],
  providers: [CleanupSchedule, CleanupProcessor],
})
export class CleanupWorkerModule {}
