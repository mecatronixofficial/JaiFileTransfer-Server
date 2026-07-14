import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type UploadSessionDocument = UploadSession & Document;

@Schema({
  timestamps: true,
  collection: 'upload_sessions',
  toJSON: { virtuals: true },
})
export class UploadSession {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Organization', default: null })
  organizationId: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'Folder', default: null })
  folderId: Types.ObjectId | null;

  @Prop({ required: true, trim: true })
  fileName: string;

  @Prop({ required: true })
  mimeType: string;

  @Prop({ required: true, min: 1 })
  size: number;

  @Prop({ required: true, unique: true })
  storageKey: string;

  @Prop({ type: String, default: null })
  uploadId: string | null;

  @Prop({ enum: ['single', 'multipart'], required: true })
  uploadType: 'single' | 'multipart';

  @Prop({
    enum: ['uploading', 'completed', 'failed', 'aborted'],
    default: 'uploading',
  })
  status: 'uploading' | 'completed' | 'failed' | 'aborted';

  @Prop({ default: 0, min: 0 })
  partsCount: number;

  @Prop({ type: Object, default: {} })
  metadata: Record<string, any>;

  @Prop({ type: Date, default: null })
  completedAt: Date | null;

  @Prop({ type: Date, default: null })
  expiresAt: Date | null;
}

export const UploadSessionSchema = SchemaFactory.createForClass(UploadSession);

UploadSessionSchema.index({ userId: 1, status: 1, createdAt: -1 });
UploadSessionSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
UploadSessionSchema.index({ uploadId: 1 });
UploadSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
