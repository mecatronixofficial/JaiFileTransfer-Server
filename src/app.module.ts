import { Module, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD, APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import {
  appConfig,
  jwtConfig,
  mongoConfig,
  r2Config,
  emailConfig,
  otpConfig,
  filesConfig,
  throttleConfig,
  cronConfig,
} from './config/configuration';

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

const dbLogger = new Logger('MongoDB');

@Module({
  imports: [
    /* =========================
       CONFIG — global; must be first so all modules can inject ConfigService
    ========================= */
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: [
        appConfig,
        jwtConfig,
        mongoConfig,
        r2Config,
        emailConfig,
        otpConfig,
        filesConfig,
        throttleConfig,
        cronConfig,
      ],
    }),

    /* =========================
       DATABASE
    ========================= */
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const uri = config.get<string>('mongo.uri');
        if (!uri) throw new Error('MongoDB URI missing in environment');

        return {
          uri,
          serverSelectionTimeoutMS: Number(
            process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS ?? 8000,
          ),
          connectTimeoutMS: Number(process.env.MONGODB_CONNECT_TIMEOUT_MS ?? 8000),
          connectionFactory: (connection) => {
            connection.on('connected', () => dbLogger.log('Connected'));
            connection.on('disconnected', () => dbLogger.warn('Disconnected'));
            connection.on('reconnected', () => dbLogger.log('Reconnected'));
            connection.on('error', (err: unknown) =>
              dbLogger.error(
                'Connection error',
                err instanceof Error ? err.stack : String(err),
              ),
            );
            return connection;
          },
        };
      },
    }),

    /* =========================
       RATE LIMITING
       Default: 100 req / 60 s per IP.
       Per-route overrides via @Throttle(). Sensitive routes (login, OTP)
       declare their own tighter limits.
    ========================= */
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: (config.get<number>('throttle.ttl') ?? 60) * 1000,
            limit: config.get<number>('throttle.limit') ?? 100,
          },
        ],
        ignoreUserAgents: [/health-check/i, /uptime-robot/i, /prometheus/i],
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
  ],
})
export class AppModule {}
