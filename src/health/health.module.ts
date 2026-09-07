import { Controller, Get, Module, VERSION_NEUTRAL } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  MongooseHealthIndicator,
  TerminusModule,
} from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/guards/jwt-auth.guard';

@Controller({ path: 'health', version: VERSION_NEUTRAL })
@Public()
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly mongo: MongooseHealthIndicator,
  ) {}

  @Get()
  live() {
    return { status: 'ok', uptime: process.uptime() };
  }

  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.mongo.pingCheck('mongodb', { timeout: 1500 }),
    ]);
  }
}

@Module({ imports: [TerminusModule], controllers: [HealthController] })
export class HealthModule {}
