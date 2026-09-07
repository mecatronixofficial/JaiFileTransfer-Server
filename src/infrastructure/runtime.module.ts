import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { CacheModule, CacheModuleOptions } from '@nestjs/cache-manager';
import { createKeyv } from '@keyv/redis';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import * as configuration from '../config/configuration';
import { StatsCacheService } from './stats-cache.service';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: Object.values(configuration),
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('mongo.uri'),
        retryAttempts: Number(config.get('MONGODB_RETRY_ATTEMPTS') ?? 3),
        retryDelay: Number(config.get('MONGODB_RETRY_DELAY_MS') ?? 3000),
        verboseRetryLog: true,
        serverSelectionTimeoutMS: Number(
          config.get('MONGODB_SERVER_SELECTION_TIMEOUT_MS') ?? 8000,
        ),
        connectTimeoutMS: Number(
          config.get('MONGODB_CONNECT_TIMEOUT_MS') ?? 8000,
        ),
        maxPoolSize: Number(config.get('MONGODB_MAX_POOL_SIZE') ?? 20),
        minPoolSize: 0,
        waitQueueTimeoutMS: 5000,
        connectionErrorFactory: (error: Error & { code?: string; syscall?: string }) => {
          if (error.code === 'ECONNREFUSED' && error.syscall === 'querySrv') {
            const wrapped = new Error(
              `MongoDB Atlas DNS SRV lookup was refused. Check DNS_SERVERS and firewall access to DNS. Cause: ${error.message}`,
            );
            Object.assign(wrapped, { cause: error });
            return wrapped;
          }
          return error;
        },
      }),
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.get<string>('LOG_LEVEL') ?? 'info',
          genReqId: () => randomUUID(),
          // Never serialize cookies, authorization headers, bodies, or token URLs.
          serializers: {
            req: (req: { id: string; method: string }) => ({
              id: req.id,
              method: req.method,
            }),
            res: (res: { statusCode: number }) => ({
              statusCode: res.statusCode,
            }),
          },
          customProps: (req: any) => ({
            route: req.route?.path ?? 'unmatched',
          }),
        },
      }),
    }),
    CacheModule.registerAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService): CacheModuleOptions => {
        const url = config.get<string>('CACHE_REDIS_URL');
        if (!url) return { ttl: 15000 };
        const store = createKeyv(
          {
            url,
            disableOfflineQueue: true,
            socket: { connectTimeout: 1000 },
          },
          { throwOnErrors: true },
        );
        // Operations report errors through StatsCacheService's bounded fallback.
        store.on('error', () => undefined);
        return { ttl: 15000, stores: [store] };
      },
    }),
  ],
  providers: [StatsCacheService],
  exports: [
    ConfigModule,
    MongooseModule,
    LoggerModule,
    CacheModule,
    StatsCacheService,
  ],
})
export class RuntimeModule {}
