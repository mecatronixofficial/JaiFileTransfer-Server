import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type LinkAccessDocument = LinkAccess & Document;

@Schema({ timestamps: true, collection: 'link_accesses', toJSON: { virtuals: true } })
export class LinkAccess {
  @Prop({ type: Types.ObjectId, ref: 'SharedLink', required: true })
  linkId: Types.ObjectId;

  @Prop({ required: true })
  shortCode: string;

  @Prop({ enum: ['link', 'qr', 'email'], default: 'link' })
  method: 'link' | 'qr' | 'email';

  @Prop({ enum: ['view', 'download'], required: true })
  action: 'view' | 'download';

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  userId: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  email: string | null;

  @Prop({ required: true })
  ip: string;

  @Prop({ type: String, default: null })
  userAgent: string | null;

  @Prop({ type: String, default: null })
  browser: string | null;

  @Prop({ type: String, default: null })
  os: string | null;

  @Prop({ type: String, default: null })
  device: string | null;

  @Prop({ type: String, default: null })
  location: string | null;

  @Prop({ type: String, default: null })
  fileId: string | null;

  @Prop({ type: String, default: null })
  fileName: string | null;
}

export const LinkAccessSchema = SchemaFactory.createForClass(LinkAccess);

LinkAccessSchema.index({ linkId: 1, createdAt: -1 });
LinkAccessSchema.index({ shortCode: 1 });
LinkAccessSchema.index({ action: 1 });
LinkAccessSchema.index({ method: 1 });
LinkAccessSchema.index({ ip: 1 });
LinkAccessSchema.index({ createdAt: -1 });
