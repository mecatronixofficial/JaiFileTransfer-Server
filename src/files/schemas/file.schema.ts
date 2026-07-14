import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type FileDocument = FileRecord & Document;

@Schema({
  timestamps: true,
  collection: 'files',
  toJSON: { virtuals: true },
})
export class FileRecord {
  /* =========================
     CORE FILE DATA
  ========================= */

  @Prop({ required: true, trim: true })
  fileName: string;

  @Prop({ required: true })
  originalName: string;

  @Prop({ required: true })
  mimeType: string;

  @Prop({ required: true, min: 1 })
  size: number;

  @Prop({ required: true, unique: true })
  key: string;

  @Prop({ default: 'r2' })
  storageProvider: string;

  @Prop({
    enum: ['active', 'trashed', 'deleted', 'processing'],
    default: 'active',
  })
  status: 'active' | 'trashed' | 'deleted' | 'processing';

  /* =========================
     RELATIONS
  ========================= */

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  uploadedBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Organization', default: null })
  organizationId: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'Folder', default: null })
  folderId: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'UploadSession', default: null })
  uploadSessionId: Types.ObjectId | null;

  /* =========================
     SOFT DELETE
  ========================= */

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: Date, default: null })
  deletedAt: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  deletedBy: Types.ObjectId | null;

  /* =========================
     EXTRA METADATA
  ========================= */

  @Prop({ type: String, default: null })
  description: string | null;

  @Prop({ type: Number, default: 0, min: 0 })
  downloadCount: number;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ type: Date, default: null })
  lastAccessedAt: Date | null;

  /* =========================
     SHARING SYSTEM
  ========================= */

  @Prop({
    type: [{ type: Types.ObjectId, ref: 'User' }],
    default: [],
  })
  sharedWith: Types.ObjectId[];

  /* =========================
     FUTURE READY
  ========================= */

  @Prop({ type: String, default: null })
  checksum?: string;

  @Prop({ type: String, default: null })
  previewUrl?: string;
}

export const FileSchema = SchemaFactory.createForClass(FileRecord);

/* =========================
   VIRTUAL FIELDS
========================= */

FileSchema.virtual('name').get(function () {
  return this.fileName;
});

FileSchema.virtual('isTrashed').get(function () {
  return this.isDeleted;
});

FileSchema.virtual('isShared').get(function () {
  return (this.sharedWith?.length ?? 0) > 0;
});

FileSchema.virtual('extension').get(function () {
  const raw = this.originalName ?? this.fileName ?? '';
  const parts = raw.split('.');
  return parts.length > 1 ? (parts.pop() ?? '').toLowerCase() : '';
});

/* =========================
   INDEXES
========================= */

FileSchema.index({ uploadedBy: 1, isDeleted: 1 });
FileSchema.index({ organizationId: 1, isDeleted: 1 });
FileSchema.index({ folderId: 1, isDeleted: 1 });
FileSchema.index({ isDeleted: 1, deletedAt: -1 });
FileSchema.index({ sharedWith: 1 });
FileSchema.index({ tags: 1 });
FileSchema.index({ mimeType: 1, isDeleted: 1 });
FileSchema.index(
  { fileName: 'text', originalName: 'text' },
  { weights: { fileName: 5, originalName: 3 } },
);
