import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type SharedLinkDocument = SharedLink & Document;

@Schema({
  timestamps: true,
  collection: 'shared_links',
  toJSON: { virtuals: true },
})
export class SharedLink {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  senderId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Organization', default: null })
  organizationId: Types.ObjectId | null;

  /** null for standalone share links; set for transfer-generated links */
  @Prop({ type: Types.ObjectId, ref: 'Transfer', default: null })
  transferId: Types.ObjectId | null;

  /** 'transfer' = created by the transfer flow; 'share' = created manually */
  @Prop({ enum: ['share', 'transfer'], default: 'transfer' })
  type: 'share' | 'transfer';

  /** Delivery surface used to create or present the link */
  @Prop({ enum: ['link', 'qr', 'email'], default: 'link' })
  method: 'link' | 'qr' | 'email';

  /** For share-type links: which files this link grants access to */
  @Prop({ type: [{ type: Types.ObjectId, ref: 'FileRecord' }], default: [] })
  fileIds: Types.ObjectId[];

  /** For share-type links: which folders this link grants access to */
  @Prop({ type: [{ type: Types.ObjectId, ref: 'Folder' }], default: [] })
  folderIds: Types.ObjectId[];

  /** What the recipient is allowed to do */
  @Prop({ enum: ['view', 'download'], default: 'download' })
  permission: 'view' | 'download';

  @Prop({ required: true, unique: true })
  shortCode: string;

  @Prop({ required: true })
  url: string;

  @Prop({ type: String, default: null })
  qrCodeUrl: string | null;

  @Prop({ enum: ['active', 'expired', 'disabled'], default: 'active' })
  status: string;

  @Prop({ default: 0 })
  views: number;

  @Prop({ default: 0 })
  downloads: number;

  @Prop({ type: Date, default: null })
  lastViewedAt: Date | null;

  @Prop({ type: Date, default: null })
  lastDownloadedAt: Date | null;

  @Prop({ type: Date, default: null })
  expiresAt: Date | null;

  @Prop({ default: false })
  hasPassword: boolean;

  @Prop({ type: String, default: null, select: false })
  passwordHash: string | null;

  @Prop({ enum: ['public', 'private', 'specific'], default: 'public' })
  privacy: string;

  @Prop({ default: 0 })
  fileCount: number;

  @Prop({ default: 0 })
  totalSize: number;
}

export const SharedLinkSchema = SchemaFactory.createForClass(SharedLink);

SharedLinkSchema.index({ senderId: 1, createdAt: -1 });
SharedLinkSchema.index({ organizationId: 1, createdAt: -1 });
SharedLinkSchema.index({ transferId: 1 });
SharedLinkSchema.index({ fileIds: 1 });
SharedLinkSchema.index({ folderIds: 1 });
SharedLinkSchema.index({ expiresAt: 1 });
SharedLinkSchema.index({ type: 1, status: 1 });
