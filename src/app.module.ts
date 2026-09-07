import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD, APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { RuntimeModule } from './infrastructure/runtime.module';
import { HealthModule } from './health/health.module';
import { CacheInvalidationInterceptor } from './infrastructure/cache-invalidation.interceptor';

import { R2Module } from './r2/r2.module';
import { MailModule } from './mail/mail.module';
import { AuthModule } from './auth/auth.module';
import { OtpModule } from './otp/otp.module';
import { UsersModule } from './users/users.module';
import { FilesModule } from './files/files.module';
import { FoldersModule } from './folders/folders.module';
import { UploadModule } from './upload/upload.module';
import { SearchModule } from './search/search.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SharesModule } from './shares/shares.module';
import { LinksModule } from './links/links.module';
import { TransfersModule } from './transfers/transfers.module';
import { TransactionsModule } from './transactions/transactions.module';
import { AdminModule } from './admin/admin.module';

import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

@Module({
  imports: [
    RuntimeModule,
    HealthModule,
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: (config.get<number>('throttle.ttl') ?? 60) * 1000,
            limit: config.get<number>('throttle.limit') ?? 100,
          },
        ],
      }),
    }),

    /* =========================
       SCHEDULER
    ========================= */
    ScheduleModule.forRoot(),

    /* =========================
       INFRASTRUCTURE (global providers — R2, Mail)
    ========================= */
    R2Module,
    MailModule,

    /* =========================
       FEATURE MODULES
    ========================= */
    AuthModule,
    OtpModule,
    UsersModule,
    FilesModule,
    FoldersModule,
    UploadModule,
    SearchModule,
    NotificationsModule,
    SharesModule,
    LinksModule,
    TransfersModule,
    TransactionsModule,
    AdminModule,
  ],

  providers: [
    // Guards execute in registration order: JWT → role → throttle
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },

    { provide: APP_FILTER, useClass: AllExceptionsFilter },

    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_INTERCEPTOR, useClass: CacheInvalidationInterceptor },
  ],
})
export class AppModule {}
