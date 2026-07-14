import {
  Controller,
  Post,
  Req,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Request } from 'express';
import { Webhook } from 'svix';
import { Public } from '../common/guards/jwt-auth.guard';
import { MailLog, MailLogDocument } from './schemas/mail-log.schema';

/* ─── Resend event shapes ─── */
interface ResendEmailData {
  email_id: string;
  from: string;
  to: string[];
  subject?: string;
  created_at: string;
  bounce?: { message: string };
}

interface ResendWebhookEvent {
  type: string;
  created_at: string;
  data: ResendEmailData;
}

@Public()
@Controller('webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);
  private readonly webhookSecret: string;

  constructor(
    private readonly configService: ConfigService,
    @InjectModel(MailLog.name)
    private readonly mailLogModel: Model<MailLogDocument>,
  ) {
    this.webhookSecret = this.configService.get<string>('email.webhookSecret') ?? '';
  }

  @Post('resend')
  @HttpCode(HttpStatus.OK)
  async handleResendWebhook(
    @Req() req: Request,
    @Headers('svix-id') svixId: string,
    @Headers('svix-timestamp') svixTimestamp: string,
    @Headers('svix-signature') svixSignature: string,
  ) {
    /* ── 1. Verify signature ─────────────────────────────────── */
    const rawBody: Buffer | undefined = (req as any).rawBody;

    if (this.webhookSecret) {
      if (!svixId || !svixTimestamp || !svixSignature) {
        throw new BadRequestException('Missing Svix signature headers');
      }
      if (!rawBody) {
        throw new BadRequestException(
          'Raw body not available — ensure rawBody:true in NestFactory.create',
        );
      }
      try {
        const wh = new Webhook(this.webhookSecret);
        wh.verify(rawBody.toString('utf8'), {
          'svix-id': svixId,
          'svix-timestamp': svixTimestamp,
          'svix-signature': svixSignature,
        });
      } catch {
        this.logger.warn('Resend webhook signature verification failed');
        throw new BadRequestException('Invalid webhook signature');
      }
    } else {
      this.logger.warn('RESEND_WEBHOOK_SECRET not set — skipping signature verification');
    }

    /* ── 2. Handle event ─────────────────────────────────────── */
    const event: ResendWebhookEvent = req.body;
    const { type, data } = event;
    const id = data?.email_id;
    const to = data?.to?.join(',') ?? 'unknown';

    this.logger.log(`Resend webhook | type=${type} | email_id=${id} | to=${to}`);

    switch (type) {
      case 'email.sent':
        await this.updateStatus(id, { status: 'sent', sentAt: new Date() });
        this.logger.log(`Email accepted by Resend | id=${id}`);
        break;

      case 'email.delivered':
        await this.updateStatus(id, { status: 'delivered', deliveredAt: new Date() });
        this.logger.log(`Email delivered | id=${id} | to=${to}`);
        break;

      case 'email.delivery_delayed':
        this.logger.warn(`Email delivery delayed | id=${id} | to=${to}`);
        break;

      case 'email.bounced':
        await this.updateStatus(id, {
          status: 'bounced',
          error: data.bounce?.message ?? 'Bounced',
        });
        this.logger.error(
          `Email bounced | id=${id} | to=${to} | reason=${data.bounce?.message ?? 'unknown'}`,
        );
        break;

      case 'email.complained':
        await this.updateStatus(id, { status: 'complained' });
        this.logger.warn(`Spam complaint | id=${id} | to=${to}`);
        break;

      case 'email.opened':
        await this.updateStatus(id, { openedAt: new Date() });
        this.logger.log(`Email opened | id=${id}`);
        break;

      case 'email.clicked':
        await this.updateStatus(id, { clickedAt: new Date() });
        this.logger.log(`Email link clicked | id=${id}`);
        break;

      default:
        this.logger.log(`Unhandled Resend event: ${type}`);
    }

    return { received: true };
  }

  private async updateStatus(
    providerMessageId: string | undefined,
    fields: Partial<{
      status: 'sent' | 'delivered' | 'bounced' | 'complained';
      error: string;
      sentAt: Date;
      deliveredAt: Date;
      openedAt: Date;
      clickedAt: Date;
    }>,
  ) {
    if (!providerMessageId) return;

    await this.mailLogModel.updateMany(
      { providerMessageId },
      { $set: fields },
    );
  }
}
