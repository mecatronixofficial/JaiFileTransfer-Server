import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type MailLogDocument = MailLog & Document;

export enum MailLogType {
  WELCOME = 'welcome',
  SHARE_INVITATION = 'share_invitation',
  SHARE_REVOKED = 'share_revoked',
  TRANSFER_LINK = 'transfer_link',
  PASSWORD_RESET_CONFIRMED = 'password_reset_confirmed',
  EMAIL_CHANGE_NOTICE = 'email_change_notice',
  STORAGE_LIMIT_WARNING = 'storage_limit_warning',
}

@Schema({
  timestamps: true,
  collection: 'mail_logs',
  toJSON: { virtuals: true },
})
export class MailLog {
  @Prop({ type: Types.ObjectId, ref: 'User', default: null, index: true })
  userId: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'Organization', default: null })
  organizationId: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'Transfer', default: null })
  transferId: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'SharedLink', default: null })
  linkId: Types.ObjectId | null;

  @Prop({ required: true, lowercase: true, trim: true })
  recipientEmail: string;

  @Prop({ type: String, enum: MailLogType, required: true })
  type: MailLogType;

  @Prop({ required: true })
  subject: string;

  @Prop({ default: 'resend' })
  provider: string;

  @Prop({ type: String, default: null })
  providerMessageId: string | null;

  @Prop({
    type: String,
    enum: ['pending', 'sent', 'delivered', 'failed', 'bounced', 'complained'],
    default: 'pending',
  })
  status: 'pending' | 'sent' | 'delivered' | 'failed' | 'bounced' | 'complained';

  @Prop({ type: String, default: null })
  error: string | null;

  @Prop({ type: Object, default: {} })
  metadata: Record<string, any>;

  @Prop({ type: Date, default: null })
  sentAt: Date | null;

  @Prop({ type: Date, default: null })
  deliveredAt: Date | null;

  @Prop({ type: Date, default: null })
  openedAt: Date | null;

  @Prop({ type: Date, default: null })
  clickedAt: Date | null;
}

export const MailLogSchema = SchemaFactory.createForClass(MailLog);

/* ─── Indexes ─────────────────────────────── */
MailLogSchema.index({ recipientEmail: 1, createdAt: -1 });
MailLogSchema.index({ organizationId: 1, createdAt: -1 });
MailLogSchema.index({ providerMessageId: 1 });
MailLogSchema.index({ transferId: 1 });
MailLogSchema.index({ status: 1, createdAt: -1 });
MailLogSchema.index({ type: 1, createdAt: -1 });

/** TTL: auto-delete mail log entries after 180 days */
MailLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });
