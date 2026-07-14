import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ShareType, SharePermission, ResourceType } from '../../common/enums';

export type ShareDocument = Share & Document;

@Schema({ timestamps: true, collection: 'shares', toJSON: { virtuals: true } })
export class Share {
  /* =========================
     IDENTITY
  ========================= */

  @Prop({ required: true, unique: true, index: true })
  shareToken: string;

  @Prop({ type: String, default: null })
  shareUrl: string | null;

  @Prop({ type: String, default: null })
  qrCodeUrl: string | null;

  @Prop({ required: true, enum: Object.values(ShareType) })
  type: ShareType;

  /* =========================
     RESOURCE
  ========================= */

  @Prop({ required: true, enum: Object.values(ResourceType) })
  resourceType: ResourceType;

  @Prop({ type: Types.ObjectId, ref: 'FileRecord', default: null })
  fileId: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'Folder', default: null })
  folderId: Types.ObjectId | null;

  /* =========================
     OWNERSHIP
  ========================= */

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Organization', default: null })
  organizationId: Types.ObjectId | null;

  /* =========================
     RECIPIENTS
  ========================= */

  @Prop({ type: [String], default: [] })
  sharedWithEmails: string[];

  @Prop({ type: [{ type: Types.ObjectId, ref: 'User' }], default: [] })
  sharedWithUserIds: Types.ObjectId[];

  /* =========================
     PERMISSIONS
  ========================= */

  @Prop({
    required: true,
    enum: Object.values(SharePermission),
    default: SharePermission.DOWNLOAD,
  })
  permission: SharePermission;

  /* =========================
     PASSWORD PROTECTION
  ========================= */

  @Prop({ type: Boolean, default: false })
  isPasswordProtected: boolean;

  @Prop({ type: String, default: null, select: false })
  passwordHash: string | null;

  /* =========================
     EXPIRY
  ========================= */

  @Prop({ type: Date, default: null })
  expiresAt: Date | null;

  /* =========================
     STATE
  ========================= */

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  /* =========================
     STATS (denormalized)
  ========================= */

  @Prop({ type: Number, default: 0, min: 0 })
  viewCount: number;

  @Prop({ type: Number, default: 0, min: 0 })
  downloadCount: number;

  /* =========================
     METADATA
  ========================= */

  @Prop({ type: String, default: null, maxlength: 200 })
  name: string | null;

  @Prop({ type: String, default: null, maxlength: 1000 })
  message: string | null;
}

export const ShareSchema = SchemaFactory.createForClass(Share);

/* =========================
   INDEXES
========================= */

ShareSchema.index({ createdBy: 1, isActive: 1 });
ShareSchema.index({ organizationId: 1, isActive: 1 });
ShareSchema.index({ createdBy: 1, createdAt: -1 });
ShareSchema.index({ fileId: 1, isActive: 1 });
ShareSchema.index({ folderId: 1, isActive: 1 });
ShareSchema.index({ sharedWithEmails: 1, isActive: 1 });
ShareSchema.index({ sharedWithUserIds: 1, isActive: 1 });
ShareSchema.index({ expiresAt: 1 });
ShareSchema.index({ type: 1, isActive: 1 });
