import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Role } from '../../common/enums';

export type UserDocument = User & Document;

export interface NotificationPreferences {
  fileShared: boolean;
  uploadComplete: boolean;
  downloadActivity: boolean;
  systemUpdates: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  fileShared: true,
  uploadComplete: true,
  downloadActivity: true,
  systemUpdates: true,
};

export interface WorkspacePreferences {
  language: 'en' | 'hi' | 'ta';
  timeFormat: '12' | '24';
}

export const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = {
  language: 'en',
  timeFormat: '12',
};

@Schema({
  timestamps: true,
  collection: 'users',
  toJSON: {
    virtuals: true,
    transform: function (_doc, ret: any) {
      delete ret.password;
      delete ret.refreshToken;
      delete ret.__v;
      return ret;
    },
  },
})
export class User {
  /* ── Identity ──────────────────────────────── */

  @Prop({ required: true, trim: true, maxlength: 100 })
  name: string;

  @Prop({
    required: true,
    lowercase: true,
    trim: true,
    unique: true,
    index: true,
  })
  email: string;

  @Prop({ required: true, select: false })
  password: string;

  /** Hashed refresh token — never exposed in responses */
  @Prop({ type: String, default: null, select: false })
  refreshToken: string | null;

  /* ── Profile ────────────────────────────────── */

  @Prop({ type: String, default: null, trim: true })
  avatar: string | null;

  @Prop({ type: String, default: null, trim: true })
  profileBanner: string | null;

  /** Private R2 object keys. Public API responses expose only proxy URLs. */
  @Prop({ type: String, default: null, select: false })
  avatarKey: string | null;

  @Prop({ type: String, default: null, select: false })
  profileBannerKey: string | null;

  @Prop({ trim: true, maxlength: 100 })
  department: string;

  @Prop({ trim: true, match: /^[0-9]{10}$/ })
  phone: string;

  /* ── Role & Status ──────────────────────────── */

  @Prop({ type: String, enum: Role, default: Role.USER })
  role: Role;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ type: Number, default: 0, index: true })
  sortOrder: number;

  @Prop({ default: false })
  isEmailVerified: boolean;

  @Prop({ default: false })
  twoFactorEnabled: boolean;

  @Prop({
    type: {
      fileShared: { type: Boolean, default: true },
      uploadComplete: { type: Boolean, default: true },
      downloadActivity: { type: Boolean, default: true },
      systemUpdates: { type: Boolean, default: true },
    },
    _id: false,
    default: () => ({ ...DEFAULT_NOTIFICATION_PREFERENCES }),
  })
  notificationPreferences: NotificationPreferences;

  @Prop({
    type: {
      language: { type: String, enum: ['en', 'hi', 'ta'], default: 'en' },
      timeFormat: { type: String, enum: ['12', '24'], default: '12' },
    },
    _id: false,
    default: () => ({ ...DEFAULT_WORKSPACE_PREFERENCES }),
  })
  workspacePreferences: WorkspacePreferences;

  /* ── Ownership ──────────────────────────────── */

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Organization', default: null })
  organizationId: Types.ObjectId | null;

  /* ── Storage ────────────────────────────────── */

  @Prop({ default: 0, min: 0 })
  storageQuota: number;

  @Prop({ default: 0, min: 0 })
  storageUsed: number;

  /* ── Security ───────────────────────────────── */

  /** Incremented on every token rotation — invalidates old JWTs */
  @Prop({ default: 0, select: false })
  tokenVersion: number;

  /* ── Activity ───────────────────────────────── */

  @Prop({ type: Date, default: null })
  lastLoginAt: Date | null;

  @Prop({ type: String, default: null })
  lastIp: string | null;

  @Prop({ type: String, default: null })
  lastUserAgent: string | null;

  @Prop({ default: 0 })
  loginCount: number;
}

export const UserSchema = SchemaFactory.createForClass(User);

/* ─── Indexes ────────────────────────────────────────────── */

UserSchema.index({ name: 1 });
UserSchema.index({ role: 1, isActive: 1 });
UserSchema.index({ createdBy: 1 });
UserSchema.index({ organizationId: 1 });

/* ─── Middleware ─────────────────────────────────────────── */

UserSchema.pre('save', function (next) {
  if (this.email) this.email = this.email.toLowerCase();
  next();
});

/* ─── Virtuals ───────────────────────────────────────────── */

UserSchema.virtual('displayName').get(function (this: User) {
  return `${this.name} (${this.email})`;
});
