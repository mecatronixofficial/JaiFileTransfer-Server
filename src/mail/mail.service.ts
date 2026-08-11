import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { join } from 'node:path';
import {
  MailLog,
  MailLogDocument,
  MailLogType,
} from './schemas/mail-log.schema';
import { SmtpService } from './smtp.service';

/* ─── Shared email context for logMail ─── */
interface MailContext {
  userId?: string | null;
  organizationId?: string | null;
  transferId?: string | null;
  linkId?: string | null;
  replyTo?: string | null;
  metadata?: Record<string, any>;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly appName: string;
  private readonly frontendUrl: string;
  private readonly logoPath = join(__dirname, 'assets', 'jai-logo.png');
  private readonly logoCid = 'jai-export-logo';

  constructor(
    private readonly configService: ConfigService,
    private readonly smtpService: SmtpService,
    @InjectModel(MailLog.name)
    private readonly mailLogModel: Model<MailLogDocument>,
  ) {
    this.appName =
      this.configService.get<string>('app.name') ?? 'Jai Export Enterprises';
    this.frontendUrl =
      this.configService.get<string>('app.frontendUrl') ??
      'http://localhost:3000';
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
      this.configService.get<string>('app.shareUrlBase') ??
      `${this.frontendUrl}/share`;
    const shareLink = `${shareUrlBase}/${shareToken}`;

    const expiryLine = expiresAt
      ? `<p style="color:#3f7801;font-size:13px;margin-top:8px">⏳ Expires: <b>${expiresAt.toUTCString()}</b></p>`
      : '';

    const messageLine = message ? this.messageBox(message) : '';

    const html = this.wrapLayout(
      `<p style="font-size:16px;color:#333;margin:0 0 12px">Hai,</p>
       <p style="font-size:15px;color:#444;margin:0 0 20px">
         <b style="color:#498c01">${sharedByName}</b> has shared a file or folder with you on ${this.appName}.
       </p>
       <div style="background:#f6faef;border:1px solid #cfe3b4;border-radius:8px;padding:20px;margin:20px 0">
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
    await this.dispatch(
      recipients,
      subject,
      html,
      MailLogType.SHARE_INVITATION,
      {
        metadata: { shareToken, resourceName },
      },
    );
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
    const safeSenderName = this.escapeHtml(senderName);
    const expiryLine = expiresAt
      ? `<p style="color:#3f7801;font-size:13px;margin-top:8px">⏳ Link expires: <b>${expiresAt.toUTCString()}</b></p>`
      : '';

    const passwordLine = hasPassword
      ? `<p style="color:#888;font-size:13px;margin-top:6px">🔒 This transfer is password-protected — ask the sender for the password.</p>`
      : '';

    const html = this.wrapLayout(
      `<p style="font-size:16px;color:#333;margin:0 0 12px">Hai,</p>
       <p style="font-size:15px;color:#444;margin:0 0 20px">
         <b style="color:#498c01">${safeSenderName}</b> has sent you a new transfer via ${this.appName}.
       </p>
       <div style="background:#f6faef;border:1px solid #cfe3b4;border-radius:8px;padding:20px;margin:20px 0">
         <p style="margin:0 0 6px;color:#666;font-size:12px;text-transform:uppercase;letter-spacing:0.5px">New Transfer</p>
         <p style="margin:0;font-size:17px;font-weight:600;color:#333">Your download is ready</p>
         ${expiryLine}
         ${passwordLine}
       </div>
       ${message ? this.messageBox(message) : ''}
       ${this.ctaButton(linkUrl, 'Open Transfer →')}
       ${this.linkFallback(linkUrl)}`,
       'Files Sent to You',
       `This transfer was sent through ${this.appName}. If you didn't expect it, you can safely ignore this email.`,
    );

    const subject = `You have a new transfer — ${this.appName}`;
    await this.dispatch(recipients, subject, html, MailLogType.TRANSFER_LINK, {
      ...context,
      metadata: { shortCode, title, linkUrl },
    });
  }

  async sendTransferDownloadedEmail(
    recipient: string,
    senderName: string,
    transferTitle: string,
    details: {
      itemName: string;
      downloadType: 'file' | 'folder' | 'all';
      fileCount?: number;
      totalSize?: number;
      ip: string;
      location: string;
      device: string;
      browser: string;
      os: string;
      downloadedAt: Date;
    },
    context: MailContext = {},
  ): Promise<void> {
    const safeSenderName = this.escapeHtml(senderName);
    const safeTransferTitle = this.escapeHtml(transferTitle);
    const safeItemName = this.escapeHtml(details.itemName);
    const label =
      details.downloadType === 'file'
        ? 'File'
        : details.downloadType === 'folder'
          ? 'Folder'
          : 'Download';
    const countRow = details.fileCount
      ? this.detailRow('Files', String(details.fileCount))
      : '';
    const sizeRow =
      typeof details.totalSize === 'number'
        ? this.detailRow('Size', this.formatBytes(details.totalSize))
        : '';
    const transferUrl = `${this.frontendUrl}/transfers/${context.transferId ?? ''}`;

    const html = this.wrapLayout(
      `<p style="font-size:16px;color:#333;margin:0 0 12px">Hai ${safeSenderName},</p>
       <p style="font-size:15px;color:#444;margin:0 0 20px">
         Someone downloaded content from your transfer <b>${safeTransferTitle}</b>.
       </p>
       <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;padding:18px;margin:20px 0">
         <p style="margin:0 0 6px;color:#047857;font-size:12px;text-transform:uppercase;letter-spacing:0.5px">Download completed</p>
         <p style="margin:0;font-size:17px;font-weight:600;color:#065f46">&#10003; ${label}: ${safeItemName}</p>
       </div>
       <table width="100%" cellpadding="8" cellspacing="0" style="border-collapse:collapse;background:#fafafa;border-radius:8px">
         ${countRow}
         ${sizeRow}
         ${this.detailRow('IP address', details.ip)}
         ${this.detailRow('Location', details.location)}
         ${this.detailRow('Device', details.device)}
         ${this.detailRow('Browser', details.browser)}
         ${this.detailRow('Operating system', details.os)}
         ${this.detailRow('Downloaded at', details.downloadedAt.toUTCString())}
       </table>
       ${context.transferId ? this.ctaButton(transferUrl, 'View Transfer Details') : ''}`,
      'Transfer Downloaded',
      'This is an automatic security and download activity notification.',
      '#498c01',
    );

    const subject = `Downloaded: ${details.itemName} — ${transferTitle}`;
    await this.dispatch(
      [recipient],
      subject,
      html,
      MailLogType.TRANSFER_DOWNLOADED,
      {
        ...context,
        metadata: {
          itemName: details.itemName,
          downloadType: details.downloadType,
          fileCount: details.fileCount ?? null,
          totalSize: details.totalSize ?? null,
          ip: details.ip,
          location: details.location,
          device: details.device,
          browser: details.browser,
          os: details.os,
          downloadedAt: details.downloadedAt,
        },
      },
    );
  }

  /* ═══════════════════════════════════════
     WELCOME EMAIL (admin-created user)
  ═══════════════════════════════════════ */
  async sendTransferExpiryReminderEmail(
    recipient: string,
    senderName: string,
    transferTitle: string,
    daysRemaining: 1 | 2 | 3,
    expiresAt: Date,
    fileCount: number,
    totalSize: number,
    context: MailContext = {},
  ): Promise<boolean> {
    const safeSenderName = this.escapeHtml(senderName);
    const safeTransferTitle = this.escapeHtml(transferTitle);
    const dayLabel = `${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`;
    const transferUrl = `${this.frontendUrl}/transfers/${context.transferId ?? ''}`;

    const html = this.wrapLayout(
      `<p style="font-size:16px;color:#333;margin:0 0 12px">Hai ${safeSenderName},</p>
       <p style="font-size:15px;color:#444;margin:0 0 20px">
         Your transfer <b>${safeTransferTitle}</b> will expire in <b>${dayLabel}</b>.
       </p>
       <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:20px;margin:20px 0;text-align:center">
         <p style="margin:0 0 6px;color:#c2410c;font-size:12px;text-transform:uppercase;letter-spacing:0.5px">Expiry reminder</p>
         <p style="margin:0;font-size:28px;font-weight:700;color:#9a3412">${dayLabel} remaining</p>
       </div>
       <table width="100%" cellpadding="8" cellspacing="0" style="border-collapse:collapse;background:#fafafa;border-radius:8px">
         ${this.detailRow('Transfer', transferTitle)}
         ${this.detailRow('Files', String(fileCount))}
         ${this.detailRow('Total size', this.formatBytes(totalSize))}
         ${this.detailRow('Expires at', expiresAt.toUTCString())}
       </table>
       ${context.transferId ? this.ctaButton(transferUrl, 'View or Extend Transfer') : ''}`,
      `Expires in ${dayLabel}`,
      'Extend the expiry from the transfer details page if recipients need more time.',
      '#498c01',
    );

    const subject = `Reminder: "${transferTitle}" expires in ${dayLabel}`;
    return this.dispatch(
      [recipient],
      subject,
      html,
      MailLogType.TRANSFER_EXPIRY_REMINDER,
      {
        ...context,
        metadata: {
          transferTitle,
          daysRemaining,
          expiresAt,
          fileCount,
          totalSize,
        },
      },
    );
  }

  async sendWelcomeEmail(
    email: string,
    name: string,
    password: string,
  ): Promise<void> {
    const loginUrl = `${this.frontendUrl}/login`;

    const html = this.wrapLayout(
      `<p style="font-size:16px;color:#333;margin:0 0 12px">Hai, <b>${name}</b>!</p>
       <p style="font-size:15px;color:#444;margin:0 0 24px">
         An administrator has created an account for you on <b>${this.appName}</b>. You can log in immediately using the credentials below.
       </p>
       <div style="background:#f6faef;border:1px solid #cfe3b4;border-radius:8px;padding:24px;margin:20px 0">
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
       <p style="font-size:13px;color:#3f7801;margin:0 0 28px">
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
      '#498c01',
    );

    const subject = `Access to "${resourceName}" has been revoked — ${this.appName}`;
    await this.dispatch(recipients, subject, html, MailLogType.SHARE_REVOKED, {
      metadata: { resourceName },
    });
  }

  /* ═══════════════════════════════════════
     PASSWORD RESET CONFIRMED
  ═══════════════════════════════════════ */
  async sendPasswordResetConfirmedEmail(
    email: string,
    name: string,
  ): Promise<void> {
    const html = this.wrapLayout(
      `<p style="font-size:16px;color:#333;margin:0 0 12px">Hai, <b>${name}</b>!</p>
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
      '#498c01',
    );

    const subject = `Your ${this.appName} password was changed`;
    await this.dispatch(
      [email],
      subject,
      html,
      MailLogType.PASSWORD_RESET_CONFIRMED,
    );
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
      `<p style="font-size:16px;color:#333;margin:0 0 12px">Hai, <b>${name}</b>!</p>
       <p style="font-size:15px;color:#444;margin:0 0 20px">
         The email address on your <b>${this.appName}</b> account has been changed.
       </p>
       <div style="background:#f6faef;border:1px solid #cfe3b4;border-radius:8px;padding:20px;margin:20px 0">
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
      '#498c01',
    );

    const subject = `Your ${this.appName} email address was changed`;
    await this.dispatch(
      [oldEmail],
      subject,
      html,
      MailLogType.EMAIL_CHANGE_NOTICE,
      {
        metadata: { oldEmail, newEmail },
      },
    );
  }

  /* ═══════════════════════════════════════
     STORAGE LIMIT WARNING
  ═══════════════════════════════════════ */
  async sendStorageLimitWarning(
    email: string,
    name: string,
    usedPercent: number,
  ): Promise<void> {
    const color = '#498c01';
    const label = usedPercent >= 100 ? 'Storage Full' : 'Storage Almost Full';
    const message =
      usedPercent >= 100
        ? `Your storage is <b>100% full</b>. You cannot upload new files until you free up space.`
        : `You have used <b>${usedPercent}%</b> of your storage quota. Consider deleting or archiving files to avoid disruption.`;

    const html = this.wrapLayout(
      `<p style="font-size:16px;color:#333;margin:0 0 12px">Hai, <b>${name}</b>!</p>
       <p style="font-size:15px;color:#444;margin:0 0 20px">${message}</p>
       ${this.ctaButton(`${this.frontendUrl}/files`, 'Manage Files →')}`,
      label,
      'Manage your storage to keep ${this.appName} running smoothly.',
      color,
    );

    const subject = `[${this.appName}] ${label} — ${usedPercent}% used`;
    await this.dispatch(
      [email],
      subject,
      html,
      MailLogType.STORAGE_LIMIT_WARNING,
      {
        metadata: { usedPercent },
      },
    );
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
      this.mailLogModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
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
  ): Promise<boolean> {
    try {
      const messageId = await this.smtpService.sendMail({
        to: recipients,
        ...(context.replyTo ? { replyTo: context.replyTo } : {}),
        subject,
        html,
        attachments: [
          {
            filename: 'jai-logo.png',
            path: this.logoPath,
            cid: this.logoCid,
            contentDisposition: 'inline',
            contentType: 'image/png',
          },
        ],
      });

      this.logger.log(
        `[${type}] sent | id=${messageId} | to=${recipients.join(',')}`,
      );
      await this.logMail(recipients, type, subject, 'sent', {
        ...context,
        providerMessageId: messageId,
      });
      return true;
    } catch (err) {
      this.logger.error(`[${type}] failed: ${(err as Error).message}`);
      await this.logMail(recipients, type, subject, 'failed', {
        ...context,
        error: (err as Error).message,
      });
      // Don't rethrow — callers should not fail because an email failed
      return false;
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
          organizationId: options.organizationId
            ? new Types.ObjectId(options.organizationId)
            : null,
          transferId: options.transferId
            ? new Types.ObjectId(options.transferId)
            : null,
          linkId: options.linkId ? new Types.ObjectId(options.linkId) : null,
          recipientEmail,
          type,
          subject,
          provider: 'smtp',
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
    accentColor = '#498c01',
  ): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <style>
    @media only screen and (max-width:620px) {
      .email-shell { width:100% !important; }
      .email-header { padding:22px 20px !important; }
      .email-body { padding:28px 22px !important; }
      .email-footer { padding:20px 22px !important; }
      .brand-title { font-size:20px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:'Segoe UI',Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f0f0f0" style="background:#f0f0f0;padding:40px 0">
    <tr><td align="center">
      <table role="presentation" class="email-shell" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff"
             style="width:100%;max-width:600px;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">
        <tr>
          <td class="email-header" bgcolor="${accentColor}"
              style="background-color:${accentColor};background-image:linear-gradient(90deg,#ffae00 0%,#498c01 58%,#244700 100%);padding:24px 30px">
            <!--[if mso]>
            <v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:600px;height:118px">
              <v:fill type="gradient" color="#ffae00" color2="#244700" angle="0" />
              <v:textbox inset="30px,20px,30px,20px">
            <![endif]-->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td width="92" valign="middle" style="width:92px">
                  <table role="presentation" width="78" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff"
                         style="width:78px;background:#ffffff;border:1px solid rgba(255,255,255,0.72);border-radius:14px">
                    <tr>
                      <td align="center" valign="middle" height="66" style="height:66px;padding:6px">
                        <img src="cid:${this.logoCid}" width="66" height="45" alt="Jai Export Enterprises logo"
                             style="display:block;width:66px;height:45px;border:0;outline:none;text-decoration:none" />
                      </td>
                    </tr>
                  </table>
                </td>
                <td valign="middle" style="padding-left:14px;text-align:left">
                  <h1 class="brand-title" style="color:#ffffff;margin:0;font-size:23px;line-height:1.25;letter-spacing:0.4px;text-shadow:0 1px 2px rgba(0,0,0,0.18)">${this.appName}</h1>
                  <p style="color:#f1f8e9;margin:7px 0 0;font-size:14px;line-height:1.35">${headerSubtitle}</p>
                </td>
              </tr>
            </table>
            <!--[if mso]>
              </v:textbox>
            </v:rect>
            <![endif]-->
          </td>
        </tr>
        <tr>
          <td class="email-body" style="padding:36px 40px">${body}</td>
        </tr>
        <tr>
          <td class="email-footer" style="background:#fafafa;border-top:1px solid #eee;padding:20px 40px;text-align:center">
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
    const safeUrl = this.escapeHtml(url);
    const safeLabel = this.escapeHtml(label);
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:32px auto 24px">
      <tr>
        <td align="center">
          <!--[if mso]>
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
            href="${safeUrl}" style="height:48px;v-text-anchor:middle;width:260px" arcsize="17%"
            strokecolor="#498c01" fillcolor="#498c01">
            <w:anchorlock/>
            <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold">${safeLabel}</center>
          </v:roundrect>
          <![endif]-->
          <!--[if !mso]><!-->
          <a href="${safeUrl}"
             style="background-color:#498c01;color:#ffffff;text-decoration:none;padding:14px 36px;
                    border:1px solid #498c01;border-radius:8px;font-family:Arial,sans-serif;
                    font-size:15px;font-weight:600;display:inline-block;letter-spacing:0.3px">
            ${safeLabel}
          </a>
          <!--<![endif]-->
        </td>
      </tr>
    </table>`;
  }

  private linkFallback(url: string): string {
    return `<p style="font-size:12px;color:#999;text-align:center;margin:0">
      Or copy this link:<br>
      <a href="${url}" style="color:#498c01;word-break:break-all">${url}</a>
    </p>`;
  }

  private messageBox(message: string): string {
    return `<div style="background:#f6faef;border-left:4px solid #498c01;padding:12px 16px;margin:16px 0;border-radius:4px">
      <p style="margin:0;color:#444;font-style:italic">"${message}"</p>
    </div>`;
  }

  private detailRow(label: string, value: string): string {
    return `<tr style="border-bottom:1px solid #eeeeee">
      <td style="width:145px;color:#777;font-size:13px">${this.escapeHtml(label)}</td>
      <td style="color:#333;font-size:13px;font-weight:600;word-break:break-word">${this.escapeHtml(value || 'Unknown')}</td>
    </tr>`;
  }

  private formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const unitIndex = Math.min(
      Math.floor(Math.log(bytes) / Math.log(1024)),
      units.length - 1,
    );
    const value = bytes / 1024 ** unitIndex;
    return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
  }

  private escapeHtml(value: unknown): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
