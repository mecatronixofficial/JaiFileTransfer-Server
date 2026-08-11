import {
  Injectable,
  Logger,
  BadRequestException,
  HttpException,
  HttpStatus,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';

import { OtpPurpose } from '../common/enums';
import { SmtpService } from '../mail/smtp.service';

/** Seconds before the user may request another OTP for the same purpose */
const RESEND_COOLDOWN_SECONDS = 60;

/** How often (ms) the background cleaner purges expired/used entries */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 min

interface OtpEntry {
  codeHash: string;
  email: string;
  fileId?: string;
  isUsed: boolean;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  expiresAt: Date;
  verifiedAt?: Date;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class OtpService implements OnModuleDestroy {
  private readonly logger = new Logger(OtpService.name);
  /** Key: `${userId}:${purpose}` — one active entry per user+purpose */
  private readonly store = new Map<string, OtpEntry>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly configService: ConfigService,
    private readonly smtpService: SmtpService,
  ) {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  onModuleDestroy() {
    clearInterval(this.cleanupTimer);
  }

  /* ═══════════════════════════════════════
     SEND OTP
  ═══════════════════════════════════════ */
  async sendOtp(
    userId: string,
    email: string,
    purpose: OtpPurpose,
    options: {
      fileId?: string;
      fileName?: string;
      ip?: string;
      userAgent?: string;
    } = {},
  ): Promise<{ message: string }> {
    const expiryMinutes = this.configService.get<number>('otp.expiryMinutes', 5);
    const key = this.storeKey(userId, purpose);
    const now = Date.now();

    /* ── Cooldown check ────────────────────────────────────────── */
    const existing = this.store.get(key);
    if (existing && !existing.isUsed && existing.expiresAt.getTime() > now) {
      const secondsAgo = Math.floor((now - existing.createdAt.getTime()) / 1000);
      if (secondsAgo < RESEND_COOLDOWN_SECONDS) {
        const waitSeconds = RESEND_COOLDOWN_SECONDS - secondsAgo;
        throw new HttpException(
          `Please wait ${waitSeconds} second(s) before requesting another OTP.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    /* ── Generate & store ──────────────────────────────────────── */
    const code = this.generateCode();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(now + expiryMinutes * 60 * 1000);

    this.store.set(key, {
      codeHash,
      email,
      fileId: options.fileId,
      isUsed: false,
      attempts: 0,
      maxAttempts: 5,
      createdAt: new Date(now),
      expiresAt,
      ip: options.ip,
      userAgent: options.userAgent,
    });

    await this.sendEmail(email, code, purpose, expiryMinutes, {
      fileName: options.fileName,
    });

    this.logger.log(
      `OTP issued | purpose=${purpose} | email=${email} | ip=${options.ip ?? 'unknown'}`,
    );

    return { message: `OTP sent to ${email}. Valid for ${expiryMinutes} minutes.` };
  }

  /* ═══════════════════════════════════════
     VERIFY OTP
  ═══════════════════════════════════════ */
  async verifyOtp(
    userId: string,
    code: string,
    purpose: OtpPurpose,
    fileId?: string,
  ): Promise<boolean> {
    const key = this.storeKey(userId, purpose);
    const entry = this.store.get(key);

    if (!entry || entry.isUsed || entry.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Invalid or expired OTP');
    }

    if (entry.attempts >= entry.maxAttempts) {
      throw new BadRequestException(
        'OTP locked — too many failed attempts. Request a new OTP.',
      );
    }

    if (fileId && entry.fileId && entry.fileId !== fileId) {
      throw new BadRequestException('OTP does not match this resource');
    }

    entry.attempts += 1;

    const isValid = await bcrypt.compare(code, entry.codeHash);

    if (!isValid) {
      const remaining = entry.maxAttempts - entry.attempts;
      throw new BadRequestException(
        remaining > 0
          ? `Invalid OTP. ${remaining} attempt(s) remaining.`
          : 'Invalid OTP. No attempts remaining — request a new OTP.',
      );
    }

    entry.isUsed = true;
    entry.verifiedAt = new Date();

    this.logger.log(`OTP verified | purpose=${purpose} | userId=${userId}`);

    return true;
  }

  /* ═══════════════════════════════════════
     INVALIDATE ALL
     Call after a successful sensitive action to clean up the entry.
  ═══════════════════════════════════════ */
  async invalidateAll(userId: string, purpose: OtpPurpose): Promise<void> {
    this.store.delete(this.storeKey(userId, purpose));
  }

  /* ═══════════════════════════════════════
     PRIVATE — HELPERS
  ═══════════════════════════════════════ */
  private storeKey(userId: string, purpose: OtpPurpose): string {
    return `${userId}:${purpose}`;
  }

  private generateCode(): string {
    return randomInt(100000, 999999).toString();
  }

  /** Remove entries that are expired or already used */
  private cleanup(): void {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (entry.isUsed || entry.expiresAt.getTime() <= now) {
        this.store.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      this.logger.debug(`OTP store cleanup: removed ${removed} stale entries`);
    }
  }

  /* ═══════════════════════════════════════
     PRIVATE — EMAIL SENDER
  ═══════════════════════════════════════ */
  private async sendEmail(
    to: string,
    code: string,
    purpose: OtpPurpose,
    expiryMinutes: number,
    ctx: { fileName?: string },
  ): Promise<void> {
    const config = this.emailConfig(purpose, ctx);
    const html = this.buildHtml(code, config, expiryMinutes);

    try {
      await this.smtpService.sendMail({
        to,
        subject: `[Jai Export Enterprises] ${config.subject}`,
        html,
      });
    } catch (err) {
      this.logger.error(
        `OTP email failed | purpose=${purpose} | to=${to} | ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw new Error('Failed to send OTP email. Please try again.');
    }
  }

  /* ═══════════════════════════════════════
     PRIVATE — PER-PURPOSE EMAIL CONFIG
  ═══════════════════════════════════════ */
  private emailConfig(
    purpose: OtpPurpose,
    ctx: { fileName?: string },
  ): {
    subject: string;
    heading: string;
    instruction: string;
    warning: string;
    accentColor: string;
  } {
    switch (purpose) {
      case OtpPurpose.RESET_PASSWORD:
        return {
          subject: 'Password Reset OTP',
          heading: 'Reset Your Password',
          instruction:
            'You requested to reset your Jai Export Enterprises account password. Enter the OTP below to continue.',
          warning:
            'If you did not request a password reset, your account may be at risk. Change your password immediately and contact support.',
          accentColor: '#e67e22',
        };

      case OtpPurpose.DELETE_FILE:
        return {
          subject: 'File Deletion OTP',
          heading: 'Confirm File Deletion',
          instruction: ctx.fileName
            ? `You are about to permanently delete <strong>${ctx.fileName}</strong>. This action cannot be undone. Enter the OTP below to confirm.`
            : 'You are about to permanently delete a file. This action cannot be undone. Enter the OTP below to confirm.',
          warning:
            'If you did not initiate this deletion, someone may have unauthorised access to your account. Contact support immediately.',
          accentColor: '#c0392b',
        };

      case OtpPurpose.CHANGE_EMAIL:
        return {
          subject: 'Email Change Verification OTP',
          heading: 'Verify Email Change',
          instruction:
            'You requested to change the email address on your Jai Export Enterprises account. Enter the OTP below to verify this change.',
          warning:
            'If you did not request an email change, ignore this email and secure your account immediately.',
          accentColor: '#2980b9',
        };

      case OtpPurpose.HIGH_RISK_ACTION:
        return {
          subject: 'Security Verification OTP',
          heading: 'Security Verification Required',
          instruction:
            'A high-risk action was initiated on your Jai Export Enterprises account. Enter the OTP below to authorise it.',
          warning:
            'If you did not initiate this action, do NOT share this OTP with anyone. Contact our support team immediately.',
          accentColor: '#8e44ad',
        };

      case OtpPurpose.TWO_FACTOR_LOGIN:
        return {
          subject: 'Sign-in Verification OTP',
          heading: 'Verify Your Sign-in',
          instruction:
            'Enter the OTP below to complete sign-in to your Jai Export Enterprises account.',
          warning:
            'If you did not try to sign in, do not share this OTP and change your password immediately.',
          accentColor: '#2980b9',
        };

      case OtpPurpose.ACCOUNT_DELETION:
        return {
          subject: 'Account Deletion OTP',
          heading: 'Confirm Account Deletion',
          instruction:
            'You requested permanent deletion of your Jai Export Enterprises account and files. Enter the OTP below to confirm.',
          warning:
            'This action cannot be undone. If you did not request it, do not share this OTP and secure your account immediately.',
          accentColor: '#c0392b',
        };

      default:
        throw new Error(`Unhandled OtpPurpose: ${purpose as string}`);
    }
  }

  /* ═══════════════════════════════════════
     PRIVATE — HTML BUILDER
  ═══════════════════════════════════════ */
  private buildHtml(
    code: string,
    config: ReturnType<OtpService['emailConfig']>,
    expiryMinutes: number,
  ): string {
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:Arial,Helvetica,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:40px 0">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0"
               style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">

          <!-- Header -->
          <tr>
            <td style="background:${config.accentColor};padding:28px 32px;text-align:center">
              <p style="margin:0;font-size:22px;font-weight:700;color:#fff;letter-spacing:.5px">
                Jai Export Enterprises
              </p>
              <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,.85)">
                Secure File Transfer Platform
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 32px 24px">
              <h2 style="margin:0 0 12px;font-size:20px;color:#1a1a2e">${config.heading}</h2>
              <p style="margin:0 0 24px;font-size:14px;color:#555;line-height:1.6">
                ${config.instruction}
              </p>

              <!-- OTP Box -->
              <div style="background:#f8f9fa;border:2px dashed ${config.accentColor};border-radius:10px;
                          padding:24px;text-align:center;margin-bottom:24px">
                <p style="margin:0 0 8px;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:1px">
                  Your One-Time Password
                </p>
                <div style="font-size:38px;font-weight:800;color:${config.accentColor};
                            letter-spacing:10px;font-variant-numeric:tabular-nums">
                  ${code}
                </div>
                <p style="margin:10px 0 0;font-size:12px;color:#888">
                  Valid for <strong>${expiryMinutes} minute${expiryMinutes !== 1 ? 's' : ''}</strong>
                  &nbsp;·&nbsp; Do not share this code
                </p>
              </div>

              <!-- Steps -->
              <ol style="margin:0 0 24px;padding-left:20px;font-size:13px;color:#555;line-height:1.8">
                <li>Go back to the Jai Export Enterprises page where you were asked for the OTP.</li>
                <li>Enter the 6-digit code shown above.</li>
                <li>Complete your action before the OTP expires.</li>
              </ol>
            </td>
          </tr>

          <!-- Warning Banner -->
          <tr>
            <td style="padding:0 32px 32px">
              <div style="background:#fff8e1;border-left:4px solid #f39c12;
                          border-radius:6px;padding:14px 16px">
                <p style="margin:0;font-size:12px;color:#7a5c00;line-height:1.6">
                  ⚠️ <strong>Security Notice:</strong> ${config.warning}
                </p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8f9fa;padding:18px 32px;text-align:center;
                       border-top:1px solid #eee">
              <p style="margin:0;font-size:11px;color:#aaa;line-height:1.6">
                This is an automated message from Jai Export Enterprises.
                Please do not reply to this email.
                <br>© ${new Date().getFullYear()} Jai Export Enterprises. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }
}
