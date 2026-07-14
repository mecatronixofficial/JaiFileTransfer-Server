import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type FolderDocument = Folder & Document;

@Schema({
  timestamps: true,
  collection: 'folders',
  toJSON: { virtuals: true },
})
export class Folder {
  /* ── Identity ───────────────────────────── */

  @Prop({ required: true, trim: true, maxlength: 200 })
  name: string;

  @Prop({ type: Types.ObjectId, ref: 'Folder', default: null })
  parentId: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Organization', default: null })
  organizationId: Types.ObjectId | null;

  /* ── Hierarchy ──────────────────────────── */

  /** Full ancestor path ending with "/", e.g. "/Work/Projects/" */
  @Prop({ type: String, default: '/' })
  path: string;

  /* ── Metadata ───────────────────────────── */

  @Prop({ type: String, default: '', maxlength: 500 })
  description: string;

  /** Hex colour for UI display, e.g. "#ff6b00" */
  @Prop({ type: String, default: null })
  color: string | null;

  /* ── Status / Soft-delete ───────────────── */

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: String, enum: ['active', 'trashed', 'deleted'], default: 'active' })
  status: 'active' | 'trashed' | 'deleted';

  @Prop({ type: Date, default: null })
  deletedAt: Date | null;

  /* ── Sharing ────────────────────────────── */

  @Prop({ type: [{ type: Types.ObjectId, ref: 'User' }], default: [] })
  sharedWith: Types.ObjectId[];
}

export const FolderSchema = SchemaFactory.createForClass(Folder);

/* ─── Indexes ────────────────────────────────────────────── */

FolderSchema.index({ createdBy: 1, isDeleted: 1 });
FolderSchema.index({ organizationId: 1, isDeleted: 1 });
FolderSchema.index({ parentId: 1, isDeleted: 1 });
FolderSchema.index({ path: 1 });
FolderSchema.index({ isDeleted: 1, deletedAt: -1 });
FolderSchema.index({ createdBy: 1, name: 1, parentId: 1 });

/** Prevent duplicate names within the same parent per user */
FolderSchema.index(
  { name: 1, parentId: 1, createdBy: 1, isDeleted: 1 },
);
