import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type SendMailOptions, type Transporter } from 'nodemailer';

@Injectable()
export class SmtpService {
  private readonly logger = new Logger(SmtpService.name);
  private readonly transporter: Transporter;
  private readonly from: { name: string; address: string };

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.getOrThrow<string>('email.host');
    const port = this.configService.getOrThrow<number>('email.port');
    const secure = this.configService.getOrThrow<boolean>('email.secure');
    const user = this.configService.getOrThrow<string>('email.user');
    const password = this.configService.getOrThrow<string>('email.password');

    this.from = {
      name:
        this.configService.get<string>('email.fromName') ||
        'Jai Export Enterprises',
      address: this.configService.get<string>('email.from') || user,
    };
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      requireTLS: !secure,
      auth: {
        user,
        pass: password,
      },
    });
  }

  async sendMail(options: Omit<SendMailOptions, 'from'>): Promise<string> {
    const info = await this.transporter.sendMail({
      ...options,
      from: this.from,
    });

    this.logger.debug(`SMTP accepted message | id=${info.messageId}`);
    return info.messageId;
  }
}
