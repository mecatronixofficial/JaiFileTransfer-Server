import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import * as dns from 'dns';
dns.setServers(['8.8.8.8', '1.1.1.1']);

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'warn', 'error'], // conservative during startup; updated below
    bufferLogs: true,
    rawBody: true, // required for Resend webhook signature verification
  });

  const configService = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  const port = configService.get<number>('app.port') ?? 5000;
  const env = configService.get<string>('app.env') ?? process.env.NODE_ENV ?? 'development';
  const isProd = env === 'production';
  const appName = configService.get<string>('app.name') ?? 'Jai Export Enterprises';
  const frontendUrl = configService.get<string>('app.frontendUrl') ?? 'http://localhost:3000';
  const apiUrl = configService.get<string>('app.apiUrl') ?? `http://localhost:${port}/api/v1`;

  // Switch to verbose logging in development after config is loaded.
  // bufferLogs:true ensures startup messages are flushed with the new logger.
  app.useLogger(
    isProd
      ? ['log', 'warn', 'error']
      : ['log', 'debug', 'verbose', 'warn', 'error'],
  );

  /* =========================
     TRUST PROXY
     Required when behind nginx/Cloudflare so req.ip reflects
     the real client IP rather than the proxy address.
  ========================= */
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  /* =========================
     BODY PARSERS
  ========================= */
  app.useBodyParser('json', { limit: '10mb' });
  app.useBodyParser('urlencoded', { limit: '10mb', extended: true });

  /* =========================
     SECURITY HEADERS
  ========================= */
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      hsts: isProd
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
        : false,
    }),
  );

  /* =========================
     MIDDLEWARE
  ========================= */
  app.use(cookieParser());
  app.use(compression());

  /* =========================
     CORS
  ========================= */
  const extraOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const allowedOrigins = [
    ...new Set([
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      frontendUrl,
      ...extraOrigins,
    ]),
  ];

  app.enableCors({
    origin: (origin, callback) => {
      // Allow server-to-server calls and browser tools (Postman, curl)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) return callback(null, true);

      if (!isProd) {
        logger.warn(`Dev CORS: allowing unlisted origin: ${origin}`);
        return callback(null, true);
      }

      logger.warn(`CORS blocked: ${origin}`);
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'Origin',
      'X-Requested-With',
    ],
    exposedHeaders: ['Content-Disposition'],
    maxAge: 86_400,
  });

  /* =========================
     ROUTING
  ========================= */
  app.setGlobalPrefix('api', { exclude: ['health', '/'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  /* =========================
     VALIDATION
  ========================= */
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      validationError: { target: false, value: false },
      stopAtFirstError: true,
    }),
  );

  /* =========================
     HEALTH CHECK
     Excluded from the /api prefix so it stays at GET /health.
  ========================= */
  const httpAdapter = app.getHttpAdapter().getInstance();
  httpAdapter.get('/health', (_req: unknown, res: any) => {
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
  });

  /* =========================
     GRACEFUL SHUTDOWN
  ========================= */
  app.enableShutdownHooks();

  const shutdown = async (signal: string) => {
    logger.log(`${signal} received — shutting down`);
    try {
      await app.close();
      logger.log('Server closed gracefully');
      process.exit(0);
    } catch (err) {
      logger.error(
        'Error during shutdown',
        err instanceof Error ? err.stack : String(err),
      );
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error(
      'Unhandled promise rejection',
      reason instanceof Error ? reason.stack : String(reason),
    );
  });

  process.on('uncaughtException', (err: Error) => {
    logger.error('Uncaught exception', err.stack);
    // Uncaught exceptions leave the process in an undefined state;
    // exit so a process manager (PM2, k8s) can restart cleanly.
    process.exit(1);
  });

  /* =========================
     START
  ========================= */
  await app.listen(port, '0.0.0.0');

  logger.log(
    [
      '',
      '═══════════════════════════════════════════',
      `  ${appName}`,
      '═══════════════════════════════════════════',
      `  Env      : ${env}`,
      `  API      : ${apiUrl}`,
      `  Frontend : ${frontendUrl}`,
      `  Port     : ${port}`,
      `  Origins  : ${allowedOrigins.join(', ')}`,
      '═══════════════════════════════════════════',
    ].join('\n'),
  );
}
void bootstrap();
