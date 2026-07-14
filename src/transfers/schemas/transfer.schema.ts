import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type TransferDocument = Transfer & Document;

/* ── Embedded: snapshot of a single file inside a transfer ── */
@Schema({ _id: false })
export class TransferFile {
  @Prop({ type: Types.ObjectId, ref: 'FileRecord', required: true })
  fileId: Types.ObjectId;

  @Prop({ required: true })
  originalName: string;

  @Prop({ required: true })
  extension: string;

  /** Relative path preserving folder structure, e.g. "vacation/photos/img.jpg" */
  @Prop({ type: String, default: null })
  relativePath: string | null;

  @Prop({ required: true })
  mimeType: string;

  @Prop({ required: true, min: 0 })
  size: number;

  /** Cloudflare R2 object key for signed downloads */
  @Prop({ required: true })
  key: string;
}
export const TransferFileSchema = SchemaFactory.createForClass(TransferFile);

/* ── Embedded: snapshot of a folder included in a transfer ── */
@Schema({ _id: false })
export class TransferFolder {
  @Prop({ type: Types.ObjectId, ref: 'Folder', required: true })
  folderId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  /** Full folder path e.g. "/vacation/photos/" */
  @Prop({ default: '/' })
  path: string;

  @Prop({ default: 0, min: 0 })
  fileCount: number;

  @Prop({ default: 0, min: 0 })
  size: number;
}
export const TransferFolderSchema =
  SchemaFactory.createForClass(TransferFolder);

/* ── Embedded: viewer access log entry ── */
@Schema({ _id: false })
export class ViewerDetail {
  @Prop({ required: true }) viewId: string;
  @Prop() name: string;
  @Prop() email: string;
  @Prop() ip: string;
  @Prop() device: string;
  @Prop() browser: string;
  @Prop() os: string;
  @Prop() location: string;
  @Prop({ required: true }) viewedAt: Date;
  @Prop() downloadedAt: Date;
  @Prop({ enum: ['view', 'download'], default: 'view' }) action: string;
}
export const ViewerDetailSchema = SchemaFactory.createForClass(ViewerDetail);

/* ── Embedded: activity timeline event ── */
@Schema({ _id: false })
export class TransferActivity {
  @Prop({ required: true }) activityId: string;
  @Prop({ required: true }) action: string;
  @Prop({ required: true }) description: string;
  @Prop() actor: string;
  @Prop() actorEmail: string;
  @Prop() ip: string;
  @Prop() location: string;
  @Prop({ required: true }) createdAt: Date;
}
export const TransferActivitySchema =
  SchemaFactory.createForClass(TransferActivity);

/* ── Main Transfer document ── */
@Schema({
  timestamps: true,
  collection: 'transfers',
  toJSON: { virtuals: true },
})
export class Transfer {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  senderId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Organization', default: null })
  organizationId: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'SharedLink', default: null })
  linkId: Types.ObjectId | null;

  @Prop({ enum: ['email', 'link', 'qr'], required: true })
  method: string;

  @Prop({ required: true })
  title: string;

  @Prop()
  subject: string;

  @Prop()
  message: string;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'FileRecord' }], default: [] })
  fileIds: Types.ObjectId[];

  @Prop({ type: [{ type: Types.ObjectId, ref: 'Folder' }], default: [] })
  folderIds: Types.ObjectId[];

  @Prop({ type: [TransferFileSchema], default: [] })
  files: TransferFile[];

  @Prop({ type: [TransferFolderSchema], default: [] })
  folders: TransferFolder[];

  @Prop({ required: true, min: 0 })
  totalSize: number;

  @Prop({ required: true, min: 0 })
  fileCount: number;

  @Prop({ default: 0, min: 0 })
  folderCount: number;

  @Prop({ type: [String], default: [] })
  recipients: string[];

  @Prop({ enum: ['public', 'private', 'specific'], default: 'public' })
  privacy: string;

  @Prop({ enum: ['active', 'expired', 'disabled'], default: 'active' })
  status: string;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ default: false })
  hasPassword: boolean;

  @Prop({ select: false })
  passwordHash: string;

  @Prop({ default: 0 })
  views: number;

  @Prop({ default: 0 })
  downloads: number;

  @Prop()
  lastViewedAt: Date;

  @Prop()
  lastDownloadedAt: Date;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'User' }], default: [] })
  starredBy: Types.ObjectId[];

  @Prop({ type: [ViewerDetailSchema], default: [] })
  viewerDetails: ViewerDetail[];

  @Prop({ type: [TransferActivitySchema], default: [] })
  activity: TransferActivity[];
}

export const TransferSchema = SchemaFactory.createForClass(Transfer);

TransferSchema.index({ senderId: 1, createdAt: -1 });
TransferSchema.index({ organizationId: 1, createdAt: -1 });
TransferSchema.index({ recipients: 1 });
TransferSchema.index({ fileIds: 1 });
TransferSchema.index({ folderIds: 1 });
TransferSchema.index({ linkId: 1 });
TransferSchema.index({ expiresAt: 1 });
TransferSchema.index({ status: 1 });
TransferSchema.index({ starredBy: 1 });
