import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Resend } from 'resend';
import { MailLog, MailLogDocument, MailLogType } from './schemas/mail-log.schema';

/* ─── Shared email context for logMail ─── */
interface MailContext {
  userId?: string | null;
  organizationId?: string | null;
  transferId?: string | null;
  linkId?: string | null;
  metadata?: Record<string, any>;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly resend: Resend;
  private readonly from: string;
  private readonly appName: string;
  private readonly frontendUrl: string;

  constructor(
    private readonly configService: ConfigService,
    @InjectModel(MailLog.name)
    private readonly mailLogModel: Model<MailLogDocument>,
  ) {
    const apiKey = this.configService.get<string>('email.apiKey');
    if (!apiKey) throw new Error('RESEND_API_KEY is missing');

    this.resend = new Resend(apiKey);
    this.from = this.configService.get<string>('email.from') ?? 'onboarding@resend.dev';
    this.appName = this.configService.get<string>('app.name') ?? 'Jai Export Enterprises';
    this.frontendUrl = this.configService.get<string>('app.frontendUrl') ?? 'http://localhost:3000';
  }

  /* ═══════════════════════════════════════
     SHARE INVITATION
  ═══════════════════════════════════════ */
  async sendShareInvitation(
    recipients: string[],
    shareToken: string,
    resourceName: string,
    sharedByName: string,
    message?: string | null,
    expiresAt?: Date,
  ): Promise<void> {
    const shareUrlBase =
      this.configService.get<string>('app.shareUrlBase') ?? `${this.frontendUrl}/share`;
    const shareLink = `${shareUrlBase}/${shareToken}`;

    const expiryLine = expiresAt
      ? `<p style="color:#e65c00;font-size:13px;margin-top:8px">⏳ Expires: <b>${expiresAt.toUTCString()}</b></p>`
      : '';

    const messageLine = message
      ? this.messageBox(message)
      : '';

    const html = this.wrapLayout(
      `<p style="font-size:16px;color:#333;margin:0 0 12px">Hello,</p>
       <p style="font-size:15px;color:#444;margin:0 0 20px">
         <b style="color:#ff6b00">${sharedByName}</b> has shared a file or folder with you on ${this.appName}.
       </p>
       <div style="background:#fff8f3;border:1px solid #ffd6b3;border-radius:8px;padding:20px;margin:20px 0">
         <p style="margin:0 0 6px;color:#666;font-size:12px;text-transform:uppercase;letter-spacing:0.5px">Shared Item</p>
         <p style="margin:0;font-size:17px;font-weight:600;color:#333">📄 ${resourceName}</p>
         ${expiryLine}
       </div>
       ${messageLine}
       ${this.ctaButton(shareLink, 'View Shared Item →')}
       ${this.linkFallback(shareLink)}`,
      'Shared With You',
      `This link was shared by <b>${sharedByName}</b>. If you didn't expect this, you can safely ignore this email.`,
    );

    const subject = `${sharedByName} shared "${resourceName}" with you — ${this.appName}`;
    await this.dispatch(recipients, subject, html, MailLogType.SHARE_INVITATION, {
      metadata: { shareToken, resourceName },
    });
  }

  /* ═══════════════════════════════════════
     TRANSFER EMAIL
  ═══════════════════════════════════════ */
  async sendTransferEmail(
    recipients: string[],
    shortCode: string,
    title: string,
    senderName: string,
    linkUrl: string,
    message?: string | null,
    expiresAt?: Date,
    hasPassword?: boolean,
    context: MailContext & { linkId?: string | null } = {},
  ): Promise<void> {
    const expiryLine = expiresAt
      ? `<p style="color:#e65c00;font-size:13px;margin-top:8px">⏳ Link expires: <b>${expiresAt.toUTCString()}</b></p>`
      : '';

    const passwordLine = hasPassword
      ? `<p style="color:#888;font-size:13px;margin-top:6px">🔒 This transfer is password-protected — ask the sender for the password.</p>`
      : '';

    const html = this.wrapLayout(
      `<p style="font-size:16px;color:#333;margin:0 0 12px">Hello,</p>
       <p style="font-size:15px;color:#444;margin:0 0 20px">
         <b style="color:#ff6b00">${senderName}</b> has sent you files via ${this.appName}.
       </p>
       <div style="background:#fff8f3;border:1px solid #ffd6b3;border-radius:8px;padding:20px;margin:20px 0">
         <p style="margin:0 0 6px;color:#666;font-size:12px;text-transform:uppercase;letter-spacing:0.5px">Transfer</p>
         <p style="margin:0;font-size:17px;font-weight:600;color:#333">📦 ${title}</p>
         ${expiryLine}
         ${passwordLine}
       </div>
       ${message ? this.messageBox(message) : ''}
       ${this.ctaButton(linkUrl, 'Download Files →')}
       ${this.linkFallback(linkUrl)}`,
      'Files Sent to You',
      `Sent by <b>${senderName}</b>. If you didn't expect this, you can safely ignore it.`,
    );

    const subject = `${senderName} sent you files — ${title}`;
    await this.dispatch(recipients, subject, html, MailLogType.TRANSFER_LINK, {
      ...context,
      metadata: { shortCode, title, linkUrl },
    });
  }

  /* ═══════════════════════════════════════
     WELCOME EMAIL (admin-created user)
  ═══════════════════════════════════════ */
  async sendWelcomeEmail(email: string, name: string, password: string): Promise<void> {
    const loginUrl = `${this.frontendUrl}/login`;

    const html = this.wrapLayout(
      `<p style="font-size:16px;color:#333;margin:0 0 12px">Hello, <b>${name}</b>!</p>
       <p style="font-size:15px;color:#444;margin:0 0 24px">
         An administrator has created an account for you on <b>${this.appName}</b>. You can log in immediately using the credentials below.
       </p>
       <div style="background:#fff8f3;border:1px solid #ffd6b3;border-radius:8px;padding:24px;margin:20px 0">
         <p style="margin:0 0 6px;color:#666;font-size:12px;text-transform:uppercase;letter-spacing:0.5px">Your Login Credentials</p>
         <table width="100%" cellpadding="6" cellspacing="0" style="margin-top:12px">
           <tr>
             <td style="color:#888;font-size:13px;width:90px">Email</td>
             <td style="color:#333;font-weight:600;font-size:14px">${email}</td>
           </tr>
           <tr>
             <td style="color:#888;font-size:13px">Password</td>
             <td style="color:#333;font-weight:600;font-size:14px;font-family:monospace;letter-spacing:1px">${password}</td>
           </tr>
         </table>
       </div>
       <p style="font-size:13px;color:#e65c00;margin:0 0 28px">
         🔒 Please change your password after your first login for security.
       </p>
       ${this.ctaButton(loginUrl, 'Log In Now →')}`,
      'Welcome to Your Account',
      'If you did not expect this account, please contact your administrator.',
    );

    const subject = `Welcome to ${this.appName} — Your Account is Ready`;
    await this.dispatch([email], subject, html, MailLogType.WELCOME);
  }

  /* ═══════════════════════════════════════
     SHARE REVOKED NOTICE
  ═══════════════════════════════════════ */
  async sendShareRevokedNotice(
    recipients: string[],
    resourceName: string,
    revokedByName: string,
  ): Promise<void> {
    const html = this.wrapLayout(
      `<p style="font-size:15px;color:#444;margin:0 0 16px">
         Your access to <b>"${resourceName}"</b> shared by <b>${revokedByName}</b> has been revoked.
       </p>
       <p style="color:#999;font-size:13px;margin:0">The share link for this item is no longer active.</p>`,
      'Access Revoked',
      `If you have questions, please contact ${revokedByName} directly.`,
      '#cc3300',
    );

    const subject = `Access to "${resourceName}" has been revoked — ${this.appName}`;
    await this.dispatch(recipients, subject, html, MailLogType.SHARE_REVOKED, {
      metadata: { resourceName },
    });
  }

  /* ═══════════════════════════════════════
     PASSWORD RESET CONFIRMED
  ═══════════════════════════════════════ */
  async sendPasswordResetConfirmedEmail(email: string, name: string): Promise<void> {
    const html = this.wrapLayout(
      `<p style="font-size:16px;color:#333;margin:0 0 12px">Hello, <b>${name}</b>!</p>
       <p style="font-size:15px;color:#444;margin:0 0 20px">
         Your password on <b>${this.appName}</b> was successfully changed.
       </p>
       <div style="background:#fff8e1;border-left:4px solid #f39c12;border-radius:6px;padding:14px 16px;margin:0 0 24px">
         <p style="margin:0;font-size:13px;color:#7a5c00;line-height:1.6">
           ⚠️ If you did not make this change, your account may be compromised. Please contact support immediately.
         </p>
       </div>
       ${this.ctaButton(`${this.frontendUrl}/login`, 'Log In →')}`,
      'Password Changed',
      'This is a security notification. No further action is required if this was you.',
      '#27ae60',
    );

    const subject = `Your ${this.appName} password was changed`;
    await this.dispatch([email], subject, html, MailLogType.PASSWORD_RESET_CONFIRMED);
  }

  /* ═══════════════════════════════════════
     EMAIL CHANGE NOTICE (sent to old address)
  ═══════════════════════════════════════ */
  async sendEmailChangeNotice(
    oldEmail: string,
    name: string,
    newEmail: string,
  ): Promise<void> {
    const html = this.wrapLayout(
      `<p style="font-size:16px;color:#333;margin:0 0 12px">Hello, <b>${name}</b>!</p>
       <p style="font-size:15px;color:#444;margin:0 0 20px">
         The email address on your <b>${this.appName}</b> account has been changed.
       </p>
       <div style="background:#fff8f3;border:1px solid #ffd6b3;border-radius:8px;padding:20px;margin:20px 0">
         <table width="100%" cellpadding="6" cellspacing="0">
           <tr>
             <td style="color:#888;font-size:13px;width:100px">Old email</td>
             <td style="color:#333;font-size:14px">${oldEmail}</td>
           </tr>
           <tr>
             <td style="color:#888;font-size:13px">New email</td>
             <td style="color:#333;font-weight:600;font-size:14px">${newEmail}</td>
           </tr>
         </table>
       </div>
       <div style="background:#fff8e1;border-left:4px solid #f39c12;border-radius:6px;padding:14px 16px">
         <p style="margin:0;font-size:13px;color:#7a5c00;line-height:1.6">
           ⚠️ If you did not request this change, contact support immediately and secure your account.
         </p>
       </div>`,
      'Email Address Changed',
      'This is a security notification sent to your previous email address.',
      '#2980b9',
    );

    const subject = `Your ${this.appName} email address was changed`;
    await this.dispatch([oldEmail], subject, html, MailLogType.EMAIL_CHANGE_NOTICE, {
      metadata: { oldEmail, newEmail },
    });
  }

  /* ═══════════════════════════════════════
     STORAGE LIMIT WARNING
  ═══════════════════════════════════════ */
  async sendStorageLimitWarning(
    email: string,
    name: string,
    usedPercent: number,
  ): Promise<void> {
    const color = usedPercent >= 100 ? '#c0392b' : '#e67e22';
    const label = usedPercent >= 100 ? 'Storage Full' : 'Storage Almost Full';
    const message =
      usedPercent >= 100
        ? `Your storage is <b>100% full</b>. You cannot upload new files until you free up space.`
        : `You have used <b>${usedPercent}%</b> of your storage quota. Consider deleting or archiving files to avoid disruption.`;

    const html = this.wrapLayout(
      `<p style="font-size:16px;color:#333;margin:0 0 12px">Hello, <b>${name}</b>!</p>
       <p style="font-size:15px;color:#444;margin:0 0 20px">${message}</p>
       ${this.ctaButton(`${this.frontendUrl}/files`, 'Manage Files →')}`,
      label,
      'Manage your storage to keep ${this.appName} running smoothly.',
      color,
    );

    const subject = `[${this.appName}] ${label} — ${usedPercent}% used`;
    await this.dispatch([email], subject, html, MailLogType.STORAGE_LIMIT_WARNING, {
      metadata: { usedPercent },
    });
  }

  /* ═══════════════════════════════════════
     ADMIN — LOGS
  ═══════════════════════════════════════ */
  async getAdminLogs(params: {
    page?: number;
    limit?: number;
    type?: MailLogType;
    status?: string;
    email?: string;
  }) {
    const page = params.page ?? 1;
    const limit = Math.min(params.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const filter: Record<string, any> = {};
    if (params.type) filter.type = params.type;
    if (params.status) filter.status = params.status;
    if (params.email) filter.recipientEmail = params.email.toLowerCase();

    const [logs, total] = await Promise.all([
      this.mailLogModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.mailLogModel.countDocuments(filter),
    ]);

    return {
      logs,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /* ═══════════════════════════════════════
     ADMIN — STATS
  ═══════════════════════════════════════ */
  async getAdminStats() {
    const [total, byStatus, byType] = await Promise.all([
      this.mailLogModel.countDocuments(),
      this.mailLogModel.aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      this.mailLogModel.aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$type', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);

    return {
      total,
      byStatus: Object.fromEntries(byStatus.map((s) => [s._id, s.count])),
      byType: Object.fromEntries(byType.map((t) => [t._id, t.count])),
    };
  }

  /* ═══════════════════════════════════════
     PRIVATE — SEND + LOG
  ═══════════════════════════════════════ */
  private async dispatch(
    recipients: string[],
    subject: string,
    html: string,
    type: MailLogType,
    context: MailContext = {},
  ): Promise<void> {
    try {
      const { data, error } = await this.resend.emails.send({
        from: this.from,
        to: recipients,
        subject,
        html,
      });

      if (error) {
        this.logger.error(`[${type}] rejected by Resend: ${JSON.stringify(error)}`);
        await this.logMail(recipients, type, subject, 'failed', {
          ...context,
          error: JSON.stringify(error),
          providerMessageId: (data as any)?.id ?? null,
        });
      } else {
        this.logger.log(`[${type}] sent | id=${data?.id} | to=${recipients.join(',')}`);
        await this.logMail(recipients, type, subject, 'sent', {
          ...context,
          providerMessageId: data?.id ?? null,
        });
      }
    } catch (err) {
      this.logger.error(`[${type}] failed: ${(err as Error).message}`);
      await this.logMail(recipients, type, subject, 'failed', {
        ...context,
        error: (err as Error).message,
      });
      // Don't rethrow — callers should not fail because an email failed
    }
  }

  private async logMail(
    recipients: string[],
    type: MailLogType,
    subject: string,
    status: 'sent' | 'failed',
    options: MailContext & {
      providerMessageId?: string | null;
      error?: string | null;
    } = {},
  ) {
    try {
      await this.mailLogModel.insertMany(
        recipients.map((recipientEmail) => ({
          userId: options.userId ? new Types.ObjectId(options.userId) : null,
          organizationId: options.organizationId ? new Types.ObjectId(options.organizationId) : null,
          transferId: options.transferId ? new Types.ObjectId(options.transferId) : null,
          linkId: options.linkId ? new Types.ObjectId(options.linkId) : null,
          recipientEmail,
          type,
          subject,
          provider: 'resend',
          providerMessageId: options.providerMessageId ?? null,
          status,
          error: options.error ?? null,
          metadata: options.metadata ?? {},
          sentAt: status === 'sent' ? new Date() : null,
        })),
      );
    } catch (err) {
      this.logger.error(`Mail log write failed: ${(err as Error).message}`);
    }
  }

  /* ═══════════════════════════════════════
     PRIVATE — HTML HELPERS
  ═══════════════════════════════════════ */
  private wrapLayout(
    body: string,
    headerSubtitle: string,
    footerNote: string,
    accentColor = '#ff6b00',
  ): string {
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:'Segoe UI',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f0f0;padding:40px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0"
             style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">
        <tr>
          <td style="background:linear-gradient(135deg,${accentColor},${accentColor}cc);padding:32px;text-align:center">
            <h1 style="color:#fff;margin:0;font-size:24px;letter-spacing:1px">${this.appName}</h1>
            <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:14px">${headerSubtitle}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px">${body}</td>
        </tr>
        <tr>
          <td style="background:#fafafa;border-top:1px solid #eee;padding:20px 40px;text-align:center">
            <p style="font-size:12px;color:#aaa;margin:0">${footerNote}</p>
            <p style="font-size:11px;color:#bbb;margin:8px 0 0">
              © ${new Date().getFullYear()} ${this.appName}. All rights reserved.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  }

  private ctaButton(url: string, label: string): string {
    return `<div style="text-align:center;margin:32px 0 24px">
      <a href="${url}"
         style="background:linear-gradient(135deg,#ff6b00,#ff8c42);color:#fff;text-decoration:none;
                padding:14px 36px;border-radius:8px;font-size:15px;font-weight:600;
                display:inline-block;letter-spacing:0.3px;box-shadow:0 4px 12px rgba(255,107,0,0.35)">
        ${label}
      </a>
    </div>`;
  }

  private linkFallback(url: string): string {
    return `<p style="font-size:12px;color:#999;text-align:center;margin:0">
      Or copy this link:<br>
      <a href="${url}" style="color:#ff6b00;word-break:break-all">${url}</a>
    </p>`;
  }

  private messageBox(message: string): string {
    return `<div style="background:#f9f9f9;border-left:4px solid #ff6b00;padding:12px 16px;margin:16px 0;border-radius:4px">
      <p style="margin:0;color:#444;font-style:italic">"${message}"</p>
    </div>`;
  }
}
