import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { TransactionQueryDto } from './dto/transaction.dto';
import { FileDocument, FileRecord } from '../files/schemas/file.schema';
import { Transfer, TransferDocument } from '../transfers/schemas/transfer.schema';
import {
  Notification,
  NotificationDocument,
} from '../notifications/schemas/notification.schema';
import { Role } from '../common/enums';

type TransactionCategory = 'upload' | 'download' | 'share' | 'delete';

type TransactionItem = {
  id: string;
  organizationId: string | null;
  action: string;
  type: TransactionCategory;
  targetType: 'file' | 'folder' | 'transfer' | 'link' | 'system' | null;
  targetId: string | null;
  fileId?: string;
  transferId?: string;
  linkId?: string | null;
  userId: string;
  user?: {
    id: string;
    name: string;
    email: string;
    role?: string;
  };
  file?: {
    id: string;
    name: string;
    mimeType?: string;
    extension?: string;
    size?: number;
  };
  ip?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: Date;
};

@Injectable()
export class TransactionsService {
  constructor(
    @InjectModel(FileRecord.name)
    private readonly fileModel: Model<FileDocument>,
    @InjectModel(Transfer.name)
    private readonly transferModel: Model<TransferDocument>,
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<NotificationDocument>,
  ) {}

  async findAll(user: any, query: TransactionQueryDto) {
    const page = Math.max(Number(query.page ?? 1), 1);
    const limit = Math.min(Math.max(Number(query.limit ?? 20), 1), 100);

    const items = await this.buildFeed(user);
    const filtered = this.applyFilters(items, query);
    const total = filtered.length;
    const transactions = filtered.slice((page - 1) * limit, page * limit);

    return {
      transactions,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(user: any, id: string) {
    const item = (await this.buildFeed(user)).find((tx) => tx.id === id);
    if (!item) throw new NotFoundException('Transaction not found');
    return item;
  }

  private async buildFeed(user: any): Promise<TransactionItem[]> {
    const userId = String(user._id);
    const isAdmin = [Role.ADMIN, Role.SUPERADMIN].includes(user.role);
    const ownerFilter = isAdmin ? {} : { uploadedBy: this.oid(userId) };
    const transferFilter = isAdmin
      ? {}
      : {
          $or: [
            { senderId: this.oid(userId) },
            { recipients: user.email },
            { starredBy: this.oid(userId) },
          ],
        };
    const notificationFilter = isAdmin ? {} : { userId: this.oid(userId) };

    const [files, transfers, notifications] = await Promise.all([
      this.fileModel
        .find(ownerFilter)
        .sort({ createdAt: -1 })
        .limit(300)
        .populate('uploadedBy', 'name email role')
        .lean(),
      this.transferModel
        .find(transferFilter)
        .sort({ createdAt: -1 })
        .limit(300)
        .populate('senderId', 'name email role')
        .lean(),
      this.notificationModel
        .find(notificationFilter)
        .sort({ createdAt: -1 })
        .limit(300)
        .populate('userId', 'name email role')
        .lean(),
    ]);

    const feed = [
      ...files.flatMap((file) => this.fileTransactions(file)),
      ...transfers.flatMap((transfer) => this.transferTransactions(transfer)),
      ...notifications
        .map((notification) => this.notificationTransaction(notification))
        .filter((item): item is TransactionItem => Boolean(item)),
    ];

    return feed.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  private applyFilters(items: TransactionItem[], query: TransactionQueryDto) {
    const search = query.search?.trim().toLowerCase();

    return items.filter((item) => {
      if (query.type && query.type !== 'all' && item.type !== query.type) {
        return false;
      }

      if (query.userId && item.userId !== query.userId) return false;
      if (query.fileId && item.fileId !== query.fileId) return false;

      if (!search) return true;

      return [
        item.action,
        item.type,
        item.file?.name,
        item.file?.mimeType,
        item.user?.name,
        item.user?.email,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(search));
    });
  }

  private fileTransactions(file: any): TransactionItem[] {
    const created = new Date(file.createdAt);
    const base = this.baseFromFile(file, 'upload_file', 'upload', created);
    const items = [base];

    if (file.isDeleted || file.status === 'trashed' || file.deletedAt) {
      items.push(
        this.baseFromFile(
          file,
          file.status === 'deleted' ? 'permanent_delete' : 'delete_file',
          'delete',
          new Date(file.deletedAt ?? file.updatedAt ?? file.createdAt),
        ),
      );
    }

    if ((file.downloadCount ?? 0) > 0 && file.lastAccessedAt) {
      items.push(
        this.baseFromFile(
          file,
          'download_file',
          'download',
          new Date(file.lastAccessedAt),
          { downloadCount: file.downloadCount },
        ),
      );
    }

    if ((file.sharedWith?.length ?? 0) > 0) {
      items.push(
        this.baseFromFile(
          file,
          'share_file',
          'share',
          new Date(file.updatedAt ?? file.createdAt),
          { sharedWithCount: file.sharedWith.length },
        ),
      );
    }

    return items;
  }

  private transferTransactions(transfer: any): TransactionItem[] {
    const sender = this.userFromDoc(transfer.senderId);
    const file = this.fileFromTransfer(transfer);
    const base = {
      organizationId: this.strOrNull(transfer.organizationId),
      targetType: 'transfer' as const,
      targetId: this.strOrNull(transfer._id),
      transferId: String(transfer._id),
      linkId: this.strOrNull(transfer.linkId),
      fileId: file?.id,
      userId: sender?.id ?? String(transfer.senderId),
      user: sender,
      file,
      metadata: {
        method: transfer.method,
        privacy: transfer.privacy,
        status: transfer.status,
        fileCount: transfer.fileCount,
        folderCount: transfer.folderCount,
        totalSize: transfer.totalSize,
        recipients: transfer.recipients,
      },
    };

    const items: TransactionItem[] = [
      {
        ...base,
        id: `transfer:${transfer._id}:send`,
        action: 'send_transfer',
        type: 'share',
        createdAt: new Date(transfer.createdAt),
      },
    ];

    if ((transfer.views ?? 0) > 0 && transfer.lastViewedAt) {
      items.push({
        ...base,
        id: `transfer:${transfer._id}:view`,
        action: 'view_transfer',
        type: 'share',
        createdAt: new Date(transfer.lastViewedAt),
        metadata: { ...base.metadata, views: transfer.views },
      });
    }

    if ((transfer.downloads ?? 0) > 0 && transfer.lastDownloadedAt) {
      items.push({
        ...base,
        id: `transfer:${transfer._id}:download`,
        action: 'download_transfer',
        type: 'download',
        createdAt: new Date(transfer.lastDownloadedAt),
        metadata: { ...base.metadata, downloads: transfer.downloads },
      });
    }

    return items;
  }

  private notificationTransaction(notification: any): TransactionItem | null {
    const category = this.categoryFromNotification(notification.type);
    if (!category) return null;

    const user = this.userFromDoc(notification.userId);
    const targetId = this.strOrNull(notification.targetId ?? notification.fileId);
    const fileName =
      notification.metadata?.fileName ??
      notification.metadata?.originalName ??
      notification.metadata?.name;

    return {
      id: `notification:${notification._id}`,
      organizationId: this.strOrNull(notification.organizationId),
      action: notification.type,
      type: category,
      targetType: notification.targetType ?? (notification.fileId ? 'file' : null),
      targetId,
      fileId:
        notification.targetType === 'file' || notification.fileId
          ? targetId ?? undefined
          : undefined,
      transferId: notification.targetType === 'transfer' ? targetId ?? undefined : undefined,
      linkId: notification.targetType === 'link' ? targetId ?? undefined : undefined,
      userId: user?.id ?? String(notification.userId),
      user,
      file: fileName
        ? {
            id: targetId ?? `notification:${notification._id}:file`,
            name: String(fileName),
            mimeType: notification.metadata?.mimeType,
            extension: notification.metadata?.extension,
            size: notification.metadata?.size,
          }
        : undefined,
      metadata: notification.metadata ?? {},
      createdAt: new Date(notification.createdAt),
    };
  }

  private baseFromFile(
    file: any,
    action: string,
    type: TransactionCategory,
    createdAt: Date,
    metadata: Record<string, unknown> = {},
  ): TransactionItem {
    const user = this.userFromDoc(file.uploadedBy);
    return {
      id: `file:${file._id}:${action}`,
      organizationId: this.strOrNull(file.organizationId),
      action,
      type,
      targetType: 'file',
      targetId: String(file._id),
      fileId: String(file._id),
      userId: user?.id ?? String(file.uploadedBy),
      user,
      file: {
        id: String(file._id),
        name: file.originalName ?? file.fileName ?? 'Unknown File',
        mimeType: file.mimeType,
        extension: this.extension(file.originalName ?? file.fileName),
        size: file.size,
      },
      metadata: {
        status: file.status,
        folderId: this.strOrNull(file.folderId),
        ...metadata,
      },
      createdAt,
    };
  }

  private fileFromTransfer(transfer: any) {
    const firstFile = transfer.files?.[0];
    if (!firstFile) {
      return transfer.title
        ? {
            id: String(transfer._id),
            name: transfer.title,
            size: transfer.totalSize,
          }
        : undefined;
    }

    return {
      id: String(firstFile.fileId),
      name: firstFile.originalName ?? transfer.title,
      mimeType: firstFile.mimeType,
      extension: firstFile.extension,
      size: firstFile.size,
    };
  }

  private categoryFromNotification(type: string): TransactionCategory | null {
    if (type.includes('upload')) return 'upload';
    if (type.includes('download')) return 'download';
    if (type.includes('share') || type.includes('transfer')) return 'share';
    if (type.includes('delete') || type.includes('restore')) return 'delete';
    return null;
  }

  private userFromDoc(doc: any) {
    if (!doc) return undefined;
    const id = doc._id ?? doc.id;
    if (!id) return undefined;

    return {
      id: String(id),
      name: doc.name ?? doc.email ?? 'Unknown User',
      email: doc.email ?? '',
      role: doc.role,
    };
  }

  private oid(id: string) {
    return new Types.ObjectId(id);
  }

  private strOrNull(value: unknown): string | null {
    return value ? String(value) : null;
  }

  private extension(name?: string) {
    if (!name || !name.includes('.')) return '';
    return name.split('.').pop()?.toLowerCase() ?? '';
  }
}
