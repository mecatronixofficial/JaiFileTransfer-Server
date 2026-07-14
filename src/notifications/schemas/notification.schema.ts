import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type NotificationDocument = Notification & Document;

export enum NotificationType {
  /* ── Files ─────────────────────────────── */
  FILE_UPLOADED = 'file_uploaded',
  FILE_SHARED = 'file_shared',
  FILE_DELETED = 'file_deleted',
  FILE_RESTORED = 'file_restored',
  /* ── Folders ───────────────────────────── */
  FOLDER_SHARED = 'folder_shared',
  /* ── Transfers ─────────────────────────── */
  TRANSFER_SENT = 'transfer_sent',
  TRANSFER_RECEIVED = 'transfer_received',
  TRANSFER_VIEWED = 'transfer_viewed',
  TRANSFER_DOWNLOADED = 'transfer_downloaded',
  /* ── Shares / Links ─────────────────────── */
  LINK_EXPIRED = 'link_expired',
  SHARE_ACCESSED = 'share_accessed',
  /* ── Account / System ───────────────────── */
  STORAGE_LIMIT = 'storage_limit',
  SYSTEM = 'system',
}

@Schema({
  timestamps: true,
  collection: 'notifications',
  toJSON: { virtuals: true },
})
export class Notification {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Organization', default: null })
  organizationId: Types.ObjectId | null;

  @Prop({ type: String, enum: NotificationType, required: true })
  type: NotificationType;

  @Prop({ required: true })
  title: string;

  @Prop({ required: true })
  message: string;

  @Prop({ default: false })
  isRead: boolean;

  @Prop({ type: Date, default: null })
  readAt: Date | null;

  /** Which resource this notification is about */
  @Prop({
    type: String,
    enum: ['file', 'folder', 'transfer', 'link', null],
    default: null,
  })
  targetType: 'file' | 'folder' | 'transfer' | 'link' | null;

  @Prop({ type: Types.ObjectId, default: null })
  targetId: Types.ObjectId | null;

  /** Legacy — kept for backwards compat; prefer targetType/targetId */
  @Prop({ type: Types.ObjectId, ref: 'FileRecord', default: null })
  fileId: Types.ObjectId | null;

  @Prop({ type: Object, default: {} })
  metadata: Record<string, any>;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);

/* ─── Indexes ────────────────────────────────────────────── */

/** Fast lookup for unread notifications per user */
NotificationSchema.index({ userId: 1, isRead: 1 });

/** Paginated list per user */
NotificationSchema.index({ userId: 1, createdAt: -1 });

/** Org-level feed */
NotificationSchema.index({ organizationId: 1, createdAt: -1 });

/** Resource-level lookup */
NotificationSchema.index({ targetType: 1, targetId: 1 });

/** TTL: auto-delete read notifications after 90 days */
NotificationSchema.index(
  { readAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60, partialFilterExpression: { isRead: true } },
);
