import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { FilesService } from './files.service';

@Injectable()
export class FilesCronService {
  private readonly logger = new Logger(FilesCronService.name);

  constructor(
    private readonly filesService: FilesService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * 🕛 Runs every day at midnight
   * Deletes files soft-deleted for more than configured retention period
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleExpiredFilesDeletion() {
    const retentionDays =
      this.configService.get<number>('files.retentionDays') ?? 7;

    this.logger.log(
      `CRON started: cleaning files older than ${retentionDays} days`,
    );

    try {
      const deletedCount =
        await this.filesService.permanentlyDeleteExpired(retentionDays);

      this.logger.log(
        deletedCount > 0
          ? `CRON success: deleted ${deletedCount} expired file(s)`
          : 'CRON completed: no expired files found',
      );
    } catch (error) {
      this.logger.error(
        `CRON failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}
