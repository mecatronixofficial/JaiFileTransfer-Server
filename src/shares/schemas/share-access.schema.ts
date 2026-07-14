import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ShareAccessAction } from '../../common/enums';

export type ShareAccessDocument = ShareAccess & Document;

@Schema({ timestamps: true, collection: 'share_accesses', toJSON: { virtuals: true } })
export class ShareAccess {
  /* =========================
     SHARE REFERENCE
  ========================= */

  @Prop({ type: Types.ObjectId, ref: 'Share', required: true })
  shareId: Types.ObjectId;

  @Prop({ required: true })
  shareToken: string;

  /* =========================
     ACCESSOR IDENTITY
  ========================= */

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  userId: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  email: string | null;

  /* =========================
     ACTION
  ========================= */

  @Prop({ required: true, enum: Object.values(ShareAccessAction) })
  action: ShareAccessAction;

  /* =========================
     REQUEST DETAILS
  ========================= */

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
}

export const ShareAccessSchema = SchemaFactory.createForClass(ShareAccess);

/* =========================
   INDEXES
========================= */

ShareAccessSchema.index({ shareId: 1, action: 1 });
ShareAccessSchema.index({ shareToken: 1 });
ShareAccessSchema.index({ userId: 1 });
ShareAccessSchema.index({ ip: 1 });
ShareAccessSchema.index({ createdAt: -1 });
