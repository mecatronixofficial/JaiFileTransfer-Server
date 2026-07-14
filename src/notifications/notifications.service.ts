import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import {
  Notification,
  NotificationDocument,
  NotificationType,
} from './schemas/notification.schema';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NotificationPreferences,
  User,
  UserDocument,
} from '../users/schemas/user.schema';

export interface CreateNotificationDto {
  userId: string;
  organizationId?: string | null;
  type: NotificationType;
  title: string;
  message: string;
  targetType?: 'file' | 'folder' | 'transfer' | 'link' | null;
  targetId?: string | null;
  /** Legacy: pass fileId directly; prefer targetType/targetId */
  fileId?: string | null;
  metadata?: Record<string, any>;
}

type LeanNotification = Omit<Notification, 'userId' | 'organizationId' | 'targetId' | 'fileId'> & {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  organizationId?: Types.ObjectId | null;
  targetId?: Types.ObjectId | null;
  fileId?: Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
};

type NotificationResponse = Omit<LeanNotification, '_id' | 'userId' | 'organizationId' | 'targetId' | 'fileId'> & {
  id: string;
  userId: string;
  organizationId: string | null;
  targetId: string | null;
  fileId: string | null;
};

@Injectable()
export class NotificationsService {
  constructor(
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<NotificationDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
  ) {}

  private preferenceKeyForType(
    type: NotificationType,
  ): keyof NotificationPreferences {
    switch (type) {
      case NotificationType.FILE_SHARED:
      case NotificationType.FOLDER_SHARED:
      case NotificationType.TRANSFER_RECEIVED:
        return 'fileShared';
      case NotificationType.FILE_UPLOADED:
        return 'uploadComplete';
      case NotificationType.TRANSFER_VIEWED:
      case NotificationType.TRANSFER_DOWNLOADED:
      case NotificationType.SHARE_ACCESSED:
        return 'downloadActivity';
      default:
        return 'systemUpdates';
    }
  }

  private async isEnabled(userId: Types.ObjectId, type: NotificationType) {
    const user = await this.userModel
      .findById(userId)
      .select('notificationPreferences')
      .lean<{ notificationPreferences?: Partial<NotificationPreferences> }>()
      .exec();
    if (!user) return false;

    const preferences = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      ...(user.notificationPreferences ?? {}),
    };
    return preferences[this.preferenceKeyForType(type)];
  }

  private oid(id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Invalid notification user or resource ID');
    }

    return new Types.ObjectId(id);
  }

  private serializeNotification(notification: LeanNotification): NotificationResponse {
    return {
      id: notification._id.toString(),
      userId: notification.userId.toString(),
      organizationId: notification.organizationId?.toString() ?? null,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      isRead: notification.isRead,
      readAt: notification.readAt,
      targetType: notification.targetType,
      targetId: notification.targetId?.toString() ?? null,
      fileId: notification.fileId?.toString() ?? null,
      metadata: notification.metadata ?? {},
      createdAt: notification.createdAt,
      updatedAt: notification.updatedAt,
    };
  }

  /* ═══════════════════════════════════════
     LIST — paginated, newest first
  ═══════════════════════════════════════ */
  async findAllForUser(userId: string, page = 1, limit = 20) {
    const uid = this.oid(userId);
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(Math.max(1, limit), 100);
    const skip = (safePage - 1) * safeLimit;

    const [notifications, total, unreadCount] = await Promise.all([
      this.notificationModel
        .find({ userId: uid })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean<LeanNotification[]>(),
      this.notificationModel.countDocuments({ userId: uid }),
      this.notificationModel.countDocuments({ userId: uid, isRead: false }),
    ]);

    return {
      notifications: notifications.map((notification) =>
        this.serializeNotification(notification),
      ),
      unreadCount,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        pages: Math.ceil(total / safeLimit),
      },
    };
  }

  /* ═══════════════════════════════════════
     UNREAD COUNT — lightweight
  ═══════════════════════════════════════ */
  async getUnreadCount(userId: string): Promise<number> {
    return this.notificationModel.countDocuments({
      userId: this.oid(userId),
      isRead: false,
    });
  }

  /* ═══════════════════════════════════════
     MARK ONE READ
  ═══════════════════════════════════════ */
  async markAsRead(notificationId: string, userId: string) {
    const now = new Date();
    const result = await this.notificationModel.findOneAndUpdate(
      { _id: this.oid(notificationId), userId: this.oid(userId) },
      { $set: { isRead: true, readAt: now } },
      { new: true },
    );

    if (!result) throw new NotFoundException('Notification not found');

    return { message: 'Notification marked as read' };
  }

  /* ═══════════════════════════════════════
     MARK MULTIPLE READ
  ═══════════════════════════════════════ */
  async bulkMarkRead(ids: string[], userId: string) {
    const uid = this.oid(userId);
    const oids = ids.map((id) => this.oid(id));
    const now = new Date();

    const result = await this.notificationModel.updateMany(
      { _id: { $in: oids }, userId: uid, isRead: false },
      { $set: { isRead: true, readAt: now } },
    );

    return { message: `${result.modifiedCount} notification(s) marked as read` };
  }

  /* ═══════════════════════════════════════
     MARK ALL READ
  ═══════════════════════════════════════ */
  async markAllAsRead(userId: string) {
    const now = new Date();
    const result = await this.notificationModel.updateMany(
      { userId: this.oid(userId), isRead: false },
      { $set: { isRead: true, readAt: now } },
    );

    return { message: `${result.modifiedCount} notification(s) marked as read` };
  }

  /* ═══════════════════════════════════════
     DELETE ONE
  ═══════════════════════════════════════ */
  async delete(notificationId: string, userId: string) {
    const result = await this.notificationModel.findOneAndDelete({
      _id: this.oid(notificationId),
      userId: this.oid(userId),
    });

    if (!result) throw new NotFoundException('Notification not found');

    return { message: 'Notification deleted' };
  }

  /* ═══════════════════════════════════════
     DELETE ALL READ for user
  ═══════════════════════════════════════ */
  async deleteAllRead(userId: string) {
    const result = await this.notificationModel.deleteMany({
      userId: this.oid(userId),
      isRead: true,
    });

    return { message: `${result.deletedCount} read notification(s) deleted` };
  }

  /* ═══════════════════════════════════════
     DELETE ALL for user
  ═══════════════════════════════════════ */
  async deleteAll(userId: string) {
    const result = await this.notificationModel.deleteMany({
      userId: this.oid(userId),
    });

    return { message: `${result.deletedCount} notification(s) deleted` };
  }

  /* ═══════════════════════════════════════
     CREATE (called internally by other services)
  ═══════════════════════════════════════ */
  async create(data: CreateNotificationDto): Promise<NotificationDocument | null> {
    const userId = this.oid(data.userId);
    if (!(await this.isEnabled(userId, data.type))) return null;

    const resolvedTargetId = data.targetId
      ? this.oid(data.targetId)
      : data.fileId
        ? this.oid(data.fileId)
        : null;

    const resolvedTargetType = data.targetType ?? (data.fileId ? 'file' : null);

    const resolvedFileId = data.fileId
      ? this.oid(data.fileId)
      : data.targetType === 'file' && data.targetId
        ? this.oid(data.targetId)
        : null;

    return this.notificationModel.create({
      userId,
      organizationId: data.organizationId ? this.oid(data.organizationId) : null,
      type: data.type,
      title: data.title,
      message: data.message,
      isRead: false,
      readAt: null,
      targetType: resolvedTargetType,
      targetId: resolvedTargetId,
      fileId: resolvedFileId,
      metadata: data.metadata ?? {},
    });
  }

  async createStorageLimitWarning(data: {
    userId: string;
    organizationId?: string | null;
    usedBytes: number;
    quotaBytes: number;
    usagePercent: number;
  }): Promise<NotificationDocument | null> {
    const uid = this.oid(data.userId);
    if (!(await this.isEnabled(uid, NotificationType.STORAGE_LIMIT))) return null;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await this.notificationModel.exists({
      userId: uid,
      type: NotificationType.STORAGE_LIMIT,
      isRead: false,
      createdAt: { $gte: since },
    });

    if (recent) return null;

    return this.notificationModel.create({
      userId: uid,
      organizationId: data.organizationId ? this.oid(data.organizationId) : null,
      type: NotificationType.STORAGE_LIMIT,
      title: 'Storage limit warning',
      message: `You have used ${data.usagePercent}% of your storage quota.`,
      isRead: false,
      readAt: null,
      targetType: null,
      targetId: null,
      fileId: null,
      metadata: {
        usedBytes: data.usedBytes,
        quotaBytes: data.quotaBytes,
        usagePercent: data.usagePercent,
      },
    });
  }

  /* ═══════════════════════════════════════
     ADMIN — STATS
  ═══════════════════════════════════════ */
  async getAdminStats() {
    const [total, unread, byType] = await Promise.all([
      this.notificationModel.countDocuments(),
      this.notificationModel.countDocuments({ isRead: false }),
      this.notificationModel.aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$type', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);

    return {
      total,
      unread,
      read: total - unread,
      byType: Object.fromEntries(byType.map((t) => [t._id, t.count])),
    };
  }
}
