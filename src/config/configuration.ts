import { registerAs } from '@nestjs/config';

/* =========================
   APP
========================= */
export const appConfig = registerAs('app', () => {
  const port = Number(process.env.APP_PORT ?? 5000);
  // Always resolve to a concrete URL — never let link URLs point at the API server
  const frontendUrl = (
    (process.env.FRONTEND_URL ?? process.env.CLIENT_URL)?.replace(/\/+$/, '')
  ) ?? 'http://localhost:3000';
  const apiUrl = (process.env.API_URL ?? `http://localhost:${port}/api/v1`).replace(/\/+$/, '');

  return {
    port,
    env: process.env.APP_ENV ?? 'development',
    name: process.env.APP_NAME ?? 'Jai Export Enterprises',
    apiUrl,
    frontendUrl,
    // Share viewer lives at  <frontend>/share/<token>
    shareUrlBase: (
      process.env.SHARE_URL_BASE ?? `${frontendUrl}/share`
    ).replace(/\/+$/, ''),
    // Transfer viewer lives at  <frontend>/t/<shortCode>
    // The service appends  /t/<shortCode>  itself, so base is just the origin.
    transferUrlBase: (
      process.env.TRANSFER_URL_BASE ?? frontendUrl
    ).replace(/\/+$/, ''),
  };
});

/* =========================
   JWT
========================= */
export const jwtConfig = registerAs('jwt', () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not defined in environment variables');

  // Separate secrets for access vs refresh tokens prevents one leaked secret
  // from compromising both token types.
  const accessSecret = process.env.JWT_ACCESS_SECRET ?? secret;
  const refreshSecret = process.env.JWT_REFRESH_SECRET ?? secret;
  const accessTokenExpiry = process.env.JWT_ACCESS_EXPIRY ?? '1d';
  const refreshTokenExpiry = process.env.JWT_REFRESH_EXPIRY ?? '30d';

  return {
    secret,
    accessSecret,
    refreshSecret,
    expiresIn: accessTokenExpiry,   // alias consumed by JwtModule.registerAsync
    accessTokenExpiry,
    refreshTokenExpiry,
    issuer: process.env.JWT_ISSUER ?? 'jai-india-api',
    audience: process.env.JWT_AUDIENCE ?? 'jai-india-users',
  };
});

/* =========================
   MONGODB
========================= */
export const mongoConfig = registerAs('mongo', () => ({
  uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017/jai-india-filetransfer',
}));

/* =========================
   CLOUDFLARE R2
========================= */
export const r2Config = registerAs('r2', () => {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 configuration is missing required credentials');
  }

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucketName: process.env.R2_BUCKET_NAME ?? 'jai-india-filetransfer',
    endpoint: process.env.R2_ENDPOINT ?? `https://${accountId}.r2.cloudflarestorage.com`,
    presignedUploadExpiry: Number(process.env.PRESIGNED_UPLOAD_EXPIRY ?? 21_600),
    presignedDownloadExpiry: Number(process.env.PRESIGNED_DOWNLOAD_EXPIRY ?? 900),
    maxFileSize: Number(process.env.R2_MAX_FILE_SIZE ?? 100 * 1024 * 1024 * 1024), // 100 GB
  };
});

/* =========================
   EMAIL (RESEND)
========================= */
export const emailConfig = registerAs('email', () => {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new Error('RESEND_API_KEY is not defined');

  return {
    provider: process.env.EMAIL_PROVIDER ?? 'resend',
    apiKey,
    from: process.env.RESEND_FROM ?? 'onboarding@resend.dev',
    webhookSecret: process.env.RESEND_WEBHOOK_SECRET ?? '',
  };
});

/* =========================
   OTP
========================= */
export const otpConfig = registerAs('otp', () => ({
  expiryMinutes: Number(process.env.OTP_EXPIRY_MINUTES ?? 5),
}));

/* =========================
   FILES
========================= */
export const filesConfig = registerAs('files', () => ({
  retentionDays: Number(process.env.SOFT_DELETE_DAYS ?? 7),
  maxUploadSizeMb: Number(process.env.MAX_UPLOAD_SIZE_MB ?? 102400), // 100 GB
}));

/* =========================
   RATE LIMITING
========================= */
export const throttleConfig = registerAs('throttle', () => ({
  ttl: Number(process.env.THROTTLE_TTL ?? 60),
  limit: Number(process.env.THROTTLE_LIMIT ?? 100),
}));

/* =========================
   CRON
========================= */
export const cronConfig = registerAs('cron', () => ({
  deleteSchedule: process.env.CRON_DELETE_SCHEDULE ?? '0 0 * * *',
}));
