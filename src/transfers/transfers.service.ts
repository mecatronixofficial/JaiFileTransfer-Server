import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import * as archiver from 'archiver';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Response } from 'express';

import { Transfer, TransferDocument } from './schemas/transfer.schema';
import {
  SendTransferDto,
  ListTransfersDto,
  TRANSFER_SEND_METHODS,
} from './dto/transfer.dto';
import { SharedLink, SharedLinkDocument } from '../links/schemas/link.schema';
import { FileRecord, FileDocument } from '../files/schemas/file.schema';
import { Folder, FolderDocument } from '../folders/schemas/folder.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { MailService } from '../mail/mail.service';
import { R2Service } from '../r2/r2.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/schemas/notification.schema';

const SALT_ROUNDS = 10;
const MAX_VIEWER_ENTRIES = 100;
const MAX_ACTIVITY_ENTRIES = 500;
const DAY_MS = 86_400_000;
const EXPIRY_REMINDER_DAYS = [3, 2, 1] as const;

type ViewerInfo = {
  ip: string;
  device: string;
  browser: string;
  os: string;
  location: string;
};

type TransferFileSnapshot = {
  fileId: Types.ObjectId;
  key: string;
  originalName: string;
  size: number;
  mimeType: string;
  extension: string;
  relativePath: string | null;
};

@Injectable()
export class TransfersService {
  private readonly logger = new Logger(TransfersService.name);
  private readonly frontendUrl: string;
  private readonly transferUrlBase: string;

  constructor(
    @InjectModel(Transfer.name)
    private readonly transferModel: Model<TransferDocument>,
    @InjectModel(SharedLink.name)
    private readonly linkModel: Model<SharedLinkDocument>,
    @InjectModel(FileRecord.name)
    private readonly fileModel: Model<FileDocument>,
    @InjectModel(Folder.name)
    private readonly folderModel: Model<FolderDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    private readonly mailService: MailService,
    private readonly r2Service: R2Service,
    private readonly configService: ConfigService,
    private readonly notificationsService: NotificationsService,
  ) {
    this.frontendUrl =
      this.configService.get<string>('app.frontendUrl') ??
      'http://localhost:3000';
    this.transferUrlBase =
      this.configService.get<string>('app.transferUrlBase') ?? this.frontendUrl;
  }

  /* ═════════════════════════════
     SCHEDULED: AUTO-EXPIRE
  ═════════════════════════════ */
  @Cron(CronExpression.EVERY_HOUR)
  async expireTransfers() {
    await this.sendExpiryReminders();
    await this.syncExpiredTransfers();
  }

  private async sendExpiryReminders(now = new Date()) {
    const reminderWindowEnd = new Date(now.getTime() + 3 * DAY_MS);
    const transfers = await this.transferModel
      .find({
        status: 'active',
        expiresAt: { $gt: now, $lte: reminderWindowEnd },
      })
      .select(
        '_id senderId organizationId linkId title expiresAt fileCount totalSize expiryReminderDaysSent',
      )
      .lean<TransferDocument[]>()
      .exec();

    if (!transfers.length) return;

    const senderIds = [
      ...new Set(transfers.map((transfer) => transfer.senderId.toString())),
    ].map((id) => new Types.ObjectId(id));
    const senders = await this.userModel
      .find({ _id: { $in: senderIds }, isActive: true })
      .select('name email notificationPreferences.systemUpdates')
      .lean<
        Array<{
          _id: Types.ObjectId;
          name: string;
          email: string;
          notificationPreferences?: { systemUpdates?: boolean };
        }>
      >()
      .exec();
    const sendersById = new Map(
      senders.map((sender) => [sender._id.toString(), sender]),
    );

    await Promise.allSettled(
      transfers.map(async (transfer) => {
        const daysRemaining = Math.ceil(
          (transfer.expiresAt.getTime() - now.getTime()) / DAY_MS,
        );
        if (
          !EXPIRY_REMINDER_DAYS.includes(
            daysRemaining as (typeof EXPIRY_REMINDER_DAYS)[number],
          ) ||
          transfer.expiryReminderDaysSent?.includes(daysRemaining)
        ) {
          return;
        }

        const sender = sendersById.get(transfer.senderId.toString());
        if (
          !sender?.email ||
          sender.notificationPreferences?.systemUpdates === false
        ) {
          return;
        }

        const claimedTransfer = await this.transferModel.findOneAndUpdate(
          {
            _id: transfer._id,
            status: 'active',
            expiresAt: transfer.expiresAt,
            expiryReminderDaysSent: { $ne: daysRemaining },
          },
          { $addToSet: { expiryReminderDaysSent: daysRemaining } },
          { new: true },
        );
        if (!claimedTransfer) return;

        const sent = await this.mailService.sendTransferExpiryReminderEmail(
          sender.email,
          sender.name,
          transfer.title,
          daysRemaining as 1 | 2 | 3,
          transfer.expiresAt,
          transfer.fileCount,
          transfer.totalSize,
          {
            userId: transfer.senderId.toString(),
            organizationId: transfer.organizationId?.toString?.() ?? null,
            transferId: transfer._id.toString(),
            linkId: transfer.linkId?.toString?.() ?? null,
          },
        );

        if (!sent) {
          await this.transferModel.findByIdAndUpdate(transfer._id, {
            $pull: { expiryReminderDaysSent: daysRemaining },
          });
        }
      }),
    );
  }

  private async syncExpiredTransfers(now = new Date()) {
    const expiringTransfers = await this.transferModel
      .find({ status: 'active', expiresAt: { $lte: now } })
      .select('_id senderId organizationId linkId title expiresAt')
      .lean<TransferDocument[]>()
      .exec();

    const [transferResult, linkResult] = await Promise.all([
      this.transferModel.updateMany(
        { _id: { $in: expiringTransfers.map((transfer) => transfer._id) } },
        { status: 'expired' },
      ),
      this.linkModel.updateMany(
        { type: 'transfer', status: 'active', expiresAt: { $lte: now } },
        { status: 'expired' },
      ),
    ]);

    if (transferResult.modifiedCount > 0 || linkResult.modifiedCount > 0) {
      this.logger.log(
        `Auto-expired ${transferResult.modifiedCount} transfer(s), ${linkResult.modifiedCount} transfer link(s)`,
      );
      await Promise.allSettled(
        expiringTransfers.map((transfer) =>
          this.notificationsService.create({
            userId: transfer.senderId.toString(),
            organizationId: transfer.organizationId?.toString?.() ?? null,
            type: NotificationType.LINK_EXPIRED,
            title: 'Transfer link expired',
            message: `Your transfer "${transfer.title}" has expired.`,
            targetType: 'transfer',
            targetId: transfer._id.toString(),
            metadata: {
              transferId: transfer._id.toString(),
              linkId: transfer.linkId?.toString?.() ?? null,
              expiresAt: transfer.expiresAt,
            },
          }),
        ),
      );
    }
  }

  private normalizeEmails(emails: string[] = []): string[] {
    return [
      ...new Set(
        emails.map((email) => email.toLowerCase().trim()).filter(Boolean),
      ),
    ];
  }

  private async notifyRegisteredTransferRecipients(options: {
    recipients: string[];
    senderId: string;
    senderName: string;
    organizationId?: string | null;
    transferId: string;
    linkId: string;
    shortCode: string;
    linkUrl: string;
    title: string;
    fileCount: number;
    folderCount: number;
  }) {
    const emails = this.normalizeEmails(options.recipients);
    if (!emails.length) return;

    const users = await this.userModel
      .find({ email: { $in: emails }, isActive: true })
      .select('_id email')
      .lean<{ _id: Types.ObjectId; email: string }[]>()
      .exec();

    await Promise.allSettled(
      users
        .filter((user) => user._id.toString() !== options.senderId)
        .map((user) =>
          this.notificationsService.create({
            userId: user._id.toString(),
            organizationId: options.organizationId ?? null,
            type: NotificationType.TRANSFER_RECEIVED,
            title: 'Transfer received',
            message: `${options.senderName} sent you "${options.title}".`,
            targetType: 'transfer',
            targetId: options.transferId,
            metadata: {
              recipientEmail: user.email,
              shortCode: options.shortCode,
              linkUrl: options.linkUrl,
              linkId: options.linkId,
              fileCount: options.fileCount,
              folderCount: options.folderCount,
              sentBy: options.senderName,
            },
          }),
        ),
    );
  }

  private async notifyTransferAccess(
    transfer: TransferDocument,
    type:
      | NotificationType.TRANSFER_VIEWED
      | NotificationType.TRANSFER_DOWNLOADED,
    viewerInfo: ViewerInfo,
    metadata: Record<string, any> = {},
  ) {
    const isDownload = type === NotificationType.TRANSFER_DOWNLOADED;
    const notificationPromise = this.notificationsService.create({
      userId: transfer.senderId.toString(),
      organizationId: transfer.organizationId?.toString?.() ?? null,
      type,
      title: isDownload ? 'Transfer downloaded' : 'Transfer viewed',
      message: `Your transfer "${transfer.title}" was ${isDownload ? 'downloaded' : 'viewed'}.`,
      targetType: 'transfer',
      targetId: transfer._id.toString(),
      metadata: {
        transferId: transfer._id.toString(),
        linkId: transfer.linkId?.toString?.() ?? null,
        ip: viewerInfo.ip,
        location: viewerInfo.location,
        device: viewerInfo.device,
        browser: viewerInfo.browser,
        os: viewerInfo.os,
        ...metadata,
      },
    });

    if (!isDownload) {
      await notificationPromise;
      return;
    }

    const sender = await this.userModel
      .findById(transfer.senderId)
      .select('name email notificationPreferences.downloadActivity')
      .lean<{
        name: string;
        email: string;
        notificationPreferences?: { downloadActivity?: boolean };
      }>()
      .exec();

    const emailPromise =
      sender?.email &&
      sender.notificationPreferences?.downloadActivity !== false
        ? this.mailService.sendTransferDownloadedEmail(
            sender.email,
            sender.name,
            transfer.title,
            {
              itemName:
                metadata.fileName ??
                metadata.zipName ??
                transfer.title ??
                'Transfer',
              downloadType: metadata.fileName
                ? 'file'
                : metadata.folderPath
                  ? 'folder'
                  : 'all',
              fileCount: metadata.fileCount,
              totalSize: metadata.totalSize,
              ip: viewerInfo.ip,
              location: viewerInfo.location,
              device: viewerInfo.device,
              browser: viewerInfo.browser,
              os: viewerInfo.os,
              downloadedAt: metadata.downloadedAt ?? new Date(),
            },
            {
              userId: transfer.senderId.toString(),
              organizationId: transfer.organizationId?.toString?.() ?? null,
              transferId: transfer._id.toString(),
              linkId: transfer.linkId?.toString?.() ?? null,
            },
          )
        : Promise.resolve();

    await Promise.allSettled([notificationPromise, emailPromise]);
  }

  /* ═════════════════════════════
     SEND
  ═════════════════════════════ */
  async send(
    dto: SendTransferDto,
    senderId: string,
    senderName: string,
    organizationId?: string | null,
    senderEmail?: string | null,
  ) {
    /* 1 — resolve selected file/folder metadata from DB */
    const senderObjectId = new Types.ObjectId(senderId);
    const fileIds = [...new Set(dto.fileIds ?? [])];
    const requestedFolderIds = [...new Set(dto.folderIds ?? [])];
    let fileDocs: any[] = [];

    if (fileIds.length > 0) {
      const invalidId = fileIds.find((id) => !Types.ObjectId.isValid(id));
      if (invalidId)
        throw new BadRequestException(`Invalid file ID: ${invalidId}`);

      fileDocs = await this.fileModel
        .find({
          _id: { $in: fileIds.map((id) => new Types.ObjectId(id)) },
          isDeleted: false,
          uploadedBy: senderObjectId,
        })
        .lean();

      if (fileDocs.length !== fileIds.length) {
        throw new BadRequestException(
          'One or more files were not found or are not available to send',
        );
      }
    }

    const fileKeys = [
      ...new Set((dto.fileKeys ?? []).map((key) => key.trim()).filter(Boolean)),
    ];
    if (fileKeys.length > 0) {
      const keyedFiles = await this.fileModel
        .find({
          key: { $in: fileKeys },
          isDeleted: false,
          uploadedBy: senderObjectId,
        })
        .lean();
      if (keyedFiles.length !== fileKeys.length) {
        throw new BadRequestException(
          'One or more file keys were not found or are not available to send',
        );
      }
      const fileById = new Map<string, any>();
      for (const file of [...fileDocs, ...keyedFiles]) {
        fileById.set((file._id as any).toString(), file);
      }
      fileDocs = Array.from(fileById.values());
    }

    let folderDocsForMap: any[] = [];
    let folderScopeIds: Types.ObjectId[] = [];

    if (requestedFolderIds.length > 0) {
      const invalidId = requestedFolderIds.find(
        (id) => !Types.ObjectId.isValid(id),
      );
      if (invalidId)
        throw new BadRequestException(`Invalid folder ID: ${invalidId}`);

      const selectedFolders = await this.folderModel
        .find({
          _id: {
            $in: requestedFolderIds.map((id) => new Types.ObjectId(id)),
          },
          isDeleted: false,
          createdBy: senderObjectId,
        })
        .lean();

      if (selectedFolders.length !== requestedFolderIds.length) {
        throw new BadRequestException(
          'One or more folders were not found or are not available to send',
        );
      }

      const descendantQueries = selectedFolders.map((folder) => ({
        createdBy: senderObjectId,
        path: {
          $regex: `^${this.escapeRegex(this.folderFullPath(folder))}`,
        },
        isDeleted: false,
      }));

      const descendantFolders = descendantQueries.length
        ? await this.folderModel.find({ $or: descendantQueries }).lean()
        : [];

      const folderById = new Map<string, any>();
      for (const folder of [...selectedFolders, ...descendantFolders]) {
        folderById.set((folder._id as any).toString(), folder);
      }

      folderDocsForMap = Array.from(folderById.values());
      folderScopeIds = Array.from(folderById.keys()).map(
        (id) => new Types.ObjectId(id),
      );

      if (folderScopeIds.length > 0) {
        const folderFileDocs = await this.fileModel
          .find({
            folderId: { $in: folderScopeIds },
            isDeleted: false,
            uploadedBy: senderObjectId,
          })
          .lean();

        const fileById = new Map<string, any>();
        for (const file of [...fileDocs, ...folderFileDocs]) {
          fileById.set((file._id as any).toString(), file);
        }
        fileDocs = Array.from(fileById.values());
      }
    }

    /* 2 — build folder map to reconstruct relative paths */
    const folderIds: string[] = [
      ...new Set(
        fileDocs.filter((f) => f.folderId).map((f) => String(f.folderId)),
      ),
    ];

    const folderMap = new Map<string, any>();
    for (const folder of folderDocsForMap) {
      folderMap.set((folder._id as any).toString(), folder);
    }

    const missingFolderIds = folderIds.filter((id) => !folderMap.has(id));
    if (missingFolderIds.length > 0) {
      const folders = await this.folderModel
        .find({
          _id: { $in: missingFolderIds.map((id) => new Types.ObjectId(id)) },
          isDeleted: false,
        })
        .lean();
      for (const folder of folders) {
        folderMap.set((folder._id as any).toString(), folder);
      }
    }

    /* Build normalised-path → real folder ObjectId map so buildFolderSnapshots
       can store actual Folder._id references instead of synthetic IDs.
       folder.path="/parent/" + folder.name="child" → "parent/child" */
    const pathToFolderIdMap = new Map<string, string>();
    for (const folder of folderMap.values()) {
      const normalizedPath = `${folder.path ?? '/'}${folder.name}`
        .split('/')
        .filter(Boolean)
        .join('/');
      if (normalizedPath) {
        pathToFolderIdMap.set(normalizedPath, (folder._id as any).toString());
      }
    }

    /* 3 — build file snapshot array */
    const transferFiles: TransferFileSnapshot[] = fileDocs.map((f) => {
      const originalName = f.originalName ?? f.fileName;
      const fileIdStr = (f._id as any).toString();
      let relativePath: string | null = null;

      const clientPath = this.normalizeRelativePath(
        dto.relativePaths?.[fileIdStr],
        originalName,
      );

      if (clientPath) {
        relativePath = clientPath;
      } else if (f.folderId) {
        const folder = folderMap.get(f.folderId.toString());
        if (folder) {
          relativePath = this.normalizeRelativePath(
            folder.path + folder.name + '/' + originalName,
            originalName,
          );
        }
      }

      return {
        fileId: f._id,
        key: f.key,
        originalName,
        size: f.size,
        mimeType: f.mimeType,
        extension: originalName.split('.').pop()?.toLowerCase() ?? '',
        relativePath,
      };
    });

    /* 4 — guard: at least one owned FileRecord is required. */
    if (transferFiles.length === 0) {
      throw new BadRequestException(
        'No files were found. Ensure each file belongs to the requesting user and has saved metadata.',
      );
    }

    /* 5 — build folder snapshot array using real folder IDs where available */
    const transferFolders = this.buildFolderSnapshots(
      transferFiles,
      pathToFolderIdMap,
    );

    const totalSize = transferFiles.reduce((s, f) => s + f.size, 0);
    const fileCount = transferFiles.length;
    const folderCount = transferFolders.length;
    const now = Date.now();
    const maxExpiresAt = now + 365 * 86_400_000;
    let expiresAt: Date;

    if (dto.expiresAt) {
      expiresAt = new Date(dto.expiresAt);
      if (expiresAt.getTime() <= now) {
        throw new BadRequestException(
          'Expiry date must be today or later',
        );
      }
      if (expiresAt.getTime() > maxExpiresAt) {
        throw new BadRequestException(
          'Expiry date cannot be more than 365 days from now',
        );
      }
    } else {
      const expiryDays = dto.expiry ?? 7;
      expiresAt = new Date(now + expiryDays * 86_400_000);
    }

    /* 6 — resolve title: prefer user-supplied, fall back to auto-generated */
    const title =
      dto.title?.trim() ||
      (fileCount === 1
        ? transferFiles[0].originalName
        : `${fileCount} files from ${senderName}`);

    /* 7 — hash password if provided */
    let passwordHash: string | undefined;
    if (dto.password) {
      passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    }

    /* 8 — create transfer */
    if (!TRANSFER_SEND_METHODS.includes(dto.method)) {
      throw new BadRequestException('Unsupported transfer method');
    }

    const recipients =
      dto.method === 'email' ? this.normalizeEmails(dto.recipients) : [];
    if (dto.method === 'email' && recipients.length === 0) {
      throw new BadRequestException(
        'At least one recipient email is required for email transfers',
      );
    }

    const transfer = await this.transferModel.create({
      senderId: new Types.ObjectId(senderId),
      organizationId: organizationId
        ? new Types.ObjectId(organizationId)
        : null,
      method: dto.method,
      title,
      subject: dto.subject,
      message: dto.message,
      fileIds: transferFiles.map((file) => file.fileId),
      folderIds: transferFolders.map((folder) => folder.folderId),
      files: transferFiles,
      folders: transferFolders,
      totalSize,
      fileCount,
      folderCount,
      recipients,
      privacy: dto.privacy ?? 'public',
      status: 'active',
      expiresAt,
      hasPassword: !!dto.password,
      passwordHash,
      activity: [
        {
          activityId: uuidv4(),
          action: 'created',
          description: `Transfer created with ${fileCount} file${fileCount !== 1 ? 's' : ''}${folderCount > 0 ? ` in ${folderCount} folder${folderCount !== 1 ? 's' : ''}` : ''} — sent via ${dto.method}`,
          createdAt: new Date(),
        },
      ],
    });

    /* 9 — create shared link */
    const shortCode = this.generateShortCode();
    const linkUrl = `${this.transferUrlBase}/t/${shortCode}`;
    const qrCodeUrl = this.generateQrCodeUrl(linkUrl);

    const link = await this.linkModel.create({
      transferId: transfer._id,
      senderId: new Types.ObjectId(senderId),
      organizationId: organizationId
        ? new Types.ObjectId(organizationId)
        : null,
      shortCode,
      url: linkUrl,
      qrCodeUrl,
      type: 'transfer',
      method: dto.method,
      fileIds: transferFiles.map((file) => file.fileId),
      folderIds: transferFolders.map((folder) => folder.folderId),
      permission: 'download',
      status: 'active',
      expiresAt,
      hasPassword: !!dto.password,
      privacy: dto.privacy ?? 'public',
      fileCount,
      totalSize,
    });

    await this.transferModel.findByIdAndUpdate(transfer._id, {
      linkId: link._id,
    });
    transfer.linkId = link._id as any;

    /* 10 — send email if method is email */
    if (dto.method === 'email' && recipients.length) {
      this.mailService
        .sendTransferEmail(
          recipients,
          shortCode,
          title,
          senderName,
          linkUrl,
          dto.message,
          expiresAt,
          !!dto.password,
          {
            userId: senderId,
            organizationId: organizationId ?? null,
            transferId: transfer._id.toString(),
            linkId: link._id.toString(),
            replyTo: senderEmail ?? null,
          },
        )
        .catch((err) =>
          this.logger.error(`Transfer email failed: ${(err as Error).message}`),
        );

      await this.notifyRegisteredTransferRecipients({
        recipients,
        senderId,
        senderName,
        organizationId,
        transferId: transfer._id.toString(),
        linkId: link._id.toString(),
        shortCode,
        linkUrl,
        title,
        fileCount,
        folderCount,
      });
    }

    this.logger.log(
      `Transfer created | sender=${senderId} | method=${dto.method} | files=${fileCount} | folders=${folderCount} | link=${shortCode}`,
    );

    // Notify sender that their transfer link is ready
    this.notificationsService
      .create({
        userId: senderId,
        organizationId: organizationId ?? null,
        type: NotificationType.TRANSFER_SENT,
        title: 'Transfer link created',
        message: `Your transfer "${title}" (${fileCount} file${fileCount !== 1 ? 's' : ''}) is ready to share.`,
        targetType: 'transfer',
        targetId: transfer._id.toString(),
        metadata: {
          shortCode,
          linkUrl,
          fileCount,
          recipientCount: recipients.length,
        },
      })
      .catch(() => undefined);

    return {
      transfer: this.formatTransfer(
        { ...transfer.toObject(), linkId: link.toObject() },
        senderId,
      ),
      link: {
        id: link._id.toString(),
        shortCode: link.shortCode,
        url: link.url,
        qrCodeUrl: link.qrCodeUrl,
        expiresAt: link.expiresAt,
      },
    };
  }

  /* ═════════════════════════════
     LIST (sent by me)
  ═════════════════════════════ */
  async findAll(
    userId: string,
    userEmail: string | undefined,
    dto: ListTransfersDto,
  ) {
    await this.syncExpiredTransfers();

    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const skip = (page - 1) * limit;
    const filter: Record<string, unknown> = {};

    const direction = dto.direction ?? 'sent';
    if (direction === 'sent') {
      filter.senderId = new Types.ObjectId(userId);
    } else if (direction === 'received') {
      filter.recipients = this.buildRecipientQuery(userId, userEmail);
    } else {
      filter.$or = [
        { senderId: new Types.ObjectId(userId) },
        { recipients: this.buildRecipientQuery(userId, userEmail) },
      ];
    }

    if (dto.status && dto.status !== 'all') {
      filter.status = dto.status;
    }

    const [transfers, total] = await Promise.all([
      this.transferModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-passwordHash -viewerDetails -activity')
        .populate(
          'linkId',
          'shortCode url status views downloads lastViewedAt lastDownloadedAt expiresAt hasPassword privacy fileCount totalSize createdAt',
        )
        .lean(),
      this.transferModel.countDocuments(filter),
    ]);

    return {
      transfers: transfers.map((t) => this.formatTransfer(t, userId)),
      total,
      page,
      limit,
    };
  }

  /* ═════════════════════════════
     DETAIL
  ═════════════════════════════ */
  async findById(id: string, userId: string, userEmail?: string) {
    await this.syncExpiredTransfers();

    if (!Types.ObjectId.isValid(id))
      throw new BadRequestException('Invalid ID');

    const transfer = await this.transferModel
      .findById(id)
      .select('-passwordHash')
      .populate('senderId', 'name email')
      .lean();

    if (!transfer) throw new NotFoundException('Transfer not found');

    const sender = transfer.senderId as any;
    const senderId =
      sender && typeof sender === 'object'
        ? sender._id?.toString?.()
        : sender?.toString?.();
    const isSender = senderId === userId;
    const isRecipient =
      (userEmail && transfer.recipients.includes(userEmail)) ||
      transfer.recipients.includes(userId);
    if (!isSender && !isRecipient) throw new ForbiddenException();

    const link = await this.linkModel
      .findOne({ transferId: transfer._id })
      .lean();

    const formatted = this.formatTransfer(transfer, userId);
    return {
      ...formatted,
      viewerDetails: (transfer.viewerDetails ?? []).map((v) => ({
        id: v.viewId,
        name: v.name,
        email: v.email,
        ip: v.ip,
        device: v.device,
        browser: v.browser,
        os: v.os,
        location: v.location,
        viewedAt: v.viewedAt,
        downloadedAt: v.downloadedAt,
        action: v.action,
      })),
      activity: (transfer.activity ?? []).map((a) => ({
        id: a.activityId,
        action: a.action,
        description: a.description,
        actor: a.actor,
        actorEmail: a.actorEmail,
        ip: a.ip,
        location: a.location,
        createdAt: a.createdAt,
      })),
      link: link
        ? {
            id: link._id.toString(),
            transferId: link.transferId?.toString(),
            url: link.url,
            qrCodeUrl: link.qrCodeUrl,
            shortCode: link.shortCode,
            status: link.status,
            views: link.views,
            downloads: link.downloads,
            lastViewedAt: link.lastViewedAt,
            lastDownloadedAt: link.lastDownloadedAt,
            expiresAt: link.expiresAt,
            hasPassword: link.hasPassword,
            privacy: link.privacy,
            fileCount: link.fileCount,
            totalSize: link.totalSize,
            createdAt: (link as any).createdAt,
          }
        : null,
      isReceived: !isSender && isRecipient,
    };
  }

  /* ═════════════════════════════
     STATS
  ═════════════════════════════ */
  async getStats(userId: string, userEmail?: string) {
    await this.syncExpiredTransfers();

    const userOid = new Types.ObjectId(userId);
    const recipientQuery = this.buildRecipientQuery(userId, userEmail);
    const [
      totalTransfers,
      activeLinks,
      received,
      starred,
      distinctRecipients,
      downloadStats,
    ] = await Promise.all([
      this.transferModel.countDocuments({ senderId: userOid }),
      this.linkModel.countDocuments({ senderId: userOid, status: 'active' }),
      this.transferModel.countDocuments({ recipients: recipientQuery }),
      this.transferModel.countDocuments({ starredBy: userOid }),
      this.transferModel.distinct('recipients', {
        senderId: userOid,
        method: 'email',
      }),
      this.transferModel.aggregate<{ totalDownloads: number }>([
        { $match: { senderId: userOid } },
        { $group: { _id: null, totalDownloads: { $sum: '$downloads' } } },
      ]),
    ]);

    const selfTransfers = await this.transferModel.countDocuments({
      senderId: userOid,
      recipients: recipientQuery,
    });

    return {
      totalTransfers,
      selfTransfers,
      totalUsers: new Set(distinctRecipients).size,
      totalDownloads: downloadStats[0]?.totalDownloads ?? 0,
      received,
      receivedMails: received,
      starred,
      starredCount: starred,
      starredMails: starred,
      activeLinks,
    };
  }

  /* ═════════════════════════════
     RECEIVED
  ═════════════════════════════ */
  async getReceived(userId: string, userEmail: string, dto: ListTransfersDto) {
    await this.syncExpiredTransfers();

    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {
      recipients: this.buildRecipientQuery(userId, userEmail),
    };

    if (dto.status && dto.status !== 'all') {
      filter.status = dto.status;
    }

    const [transfers, total] = await Promise.all([
      this.transferModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-passwordHash -viewerDetails -activity')
        .populate(
          'linkId',
          'shortCode url status views downloads lastViewedAt lastDownloadedAt expiresAt hasPassword privacy fileCount totalSize createdAt',
        )
        .populate('senderId', 'name email')
        .lean(),
      this.transferModel.countDocuments(filter),
    ]);

    return {
      transfers: transfers.map((t) => ({
        ...this.formatTransfer(t, userId),
        isReceived: true,
      })),
      total,
      page,
      limit,
    };
  }

  /* ═════════════════════════════
     STAR / UNSTAR
  ═════════════════════════════ */
  async star(id: string, userId: string) {
    if (!Types.ObjectId.isValid(id))
      throw new BadRequestException('Invalid ID');
    const userOid = new Types.ObjectId(userId);
    const result = await this.transferModel.findByIdAndUpdate(id, {
      $addToSet: { starredBy: userOid },
    });
    if (!result) throw new NotFoundException('Transfer not found');
  }

  async unstar(id: string, userId: string) {
    if (!Types.ObjectId.isValid(id))
      throw new BadRequestException('Invalid ID');
    const userOid = new Types.ObjectId(userId);
    const result = await this.transferModel.findByIdAndUpdate(id, {
      $pull: { starredBy: userOid },
    });
    if (!result) throw new NotFoundException('Transfer not found');
  }

  async getStarred(
    userId: string,
    userEmail: string | undefined,
    dto: ListTransfersDto,
  ) {
    await this.syncExpiredTransfers();

    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const skip = (page - 1) * limit;
    const userOid = new Types.ObjectId(userId);
    const recipientQuery = this.buildRecipientQuery(userId, userEmail);

    const [transfers, total] = await Promise.all([
      this.transferModel
        .find({ starredBy: userOid })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-passwordHash -viewerDetails -activity')
        .populate(
          'linkId',
          'shortCode url status views downloads lastViewedAt lastDownloadedAt expiresAt hasPassword privacy fileCount totalSize createdAt',
        )
        .populate('senderId', 'name email')
        .lean(),
      this.transferModel.countDocuments({ starredBy: userOid }),
    ]);

    return {
      transfers: transfers.map((t) => ({
        ...this.formatTransfer(t, userId),
        isReceived: (t.recipients ?? []).some((recipient: string) =>
          recipientQuery.$in.includes(recipient),
        ),
      })),
      total,
      page,
      limit,
    };
  }

  /* ═════════════════════════════
     DELETE
  ═════════════════════════════ */
  async delete(id: string, userId: string) {
    if (!Types.ObjectId.isValid(id))
      throw new BadRequestException('Invalid ID');

    const transfer = await this.transferModel.findById(id);
    if (!transfer) throw new NotFoundException('Transfer not found');
    if (transfer.senderId.toString() !== userId) throw new ForbiddenException();

    await Promise.all([
      this.transferModel.findByIdAndDelete(id),
      this.linkModel.deleteOne({ transferId: transfer._id }),
    ]);
  }

  /* ═════════════════════════════
     DISABLE LINK
  ═════════════════════════════ */
  async disable(id: string, userId: string) {
    if (!Types.ObjectId.isValid(id))
      throw new BadRequestException('Invalid ID');

    const transfer = await this.transferModel.findById(id);
    if (!transfer) throw new NotFoundException('Transfer not found');
    if (transfer.senderId.toString() !== userId) throw new ForbiddenException();
    if (transfer.status === 'disabled')
      throw new BadRequestException('Transfer is already disabled');

    const now = new Date();
    await Promise.all([
      this.transferModel.findByIdAndUpdate(id, {
        status: 'disabled',
        $push: {
          activity: {
            $each: [
              {
                activityId: uuidv4(),
                action: 'link_disabled',
                description: 'Transfer link disabled by sender',
                createdAt: now,
              },
            ],
            $slice: -MAX_ACTIVITY_ENTRIES,
          },
        },
      }),
      this.linkModel.findOneAndUpdate(
        { transferId: transfer._id },
        { status: 'disabled' },
      ),
    ]);
  }

  /* ═════════════════════════════
     ENABLE LINK
  ═════════════════════════════ */
  async enable(id: string, userId: string) {
    if (!Types.ObjectId.isValid(id))
      throw new BadRequestException('Invalid ID');

    const transfer = await this.transferModel.findById(id);
    if (!transfer) throw new NotFoundException('Transfer not found');
    if (transfer.senderId.toString() !== userId) throw new ForbiddenException();
    if (
      transfer.status === 'expired' ||
      (transfer.expiresAt && transfer.expiresAt <= new Date())
    )
      throw new BadRequestException(
        'Cannot re-enable an expired transfer — extend the expiry first',
      );
    if (transfer.status !== 'disabled')
      throw new BadRequestException('Transfer is not disabled');

    const now = new Date();
    await Promise.all([
      this.transferModel.findByIdAndUpdate(id, {
        status: 'active',
        $push: {
          activity: {
            $each: [
              {
                activityId: uuidv4(),
                action: 'link_enabled',
                description: 'Transfer link re-enabled by sender',
                createdAt: now,
              },
            ],
            $slice: -MAX_ACTIVITY_ENTRIES,
          },
        },
      }),
      this.linkModel.findOneAndUpdate(
        { transferId: transfer._id },
        { status: 'active' },
      ),
    ]);
  }

  /* ═════════════════════════════
     EXTEND EXPIRY
  ═════════════════════════════ */
  async extend(id: string, userId: string, days: number) {
    if (!Types.ObjectId.isValid(id))
      throw new BadRequestException('Invalid ID');
    if (!days || days < 1 || days > 365)
      throw new BadRequestException('Days must be between 1 and 365');

    const transfer = await this.transferModel.findById(id);
    if (!transfer) throw new NotFoundException('Transfer not found');
    if (transfer.senderId.toString() !== userId) throw new ForbiddenException();

    const base =
      transfer.expiresAt && transfer.expiresAt > new Date()
        ? transfer.expiresAt
        : new Date();
    const newExpiry = new Date(base.getTime() + days * 86_400_000);
    const now = new Date();

    await Promise.all([
      this.transferModel.findByIdAndUpdate(id, {
        expiresAt: newExpiry,
        expiryReminderDaysSent: [],
        ...(transfer.status === 'expired' ? { status: 'active' } : {}),
        $push: {
          activity: {
            $each: [
              {
                activityId: uuidv4(),
                action: 'expiry_extended',
                description: `Transfer expiry extended by ${days} day${days !== 1 ? 's' : ''} — new expiry: ${newExpiry.toISOString().split('T')[0]}`,
                createdAt: now,
              },
            ],
            $slice: -MAX_ACTIVITY_ENTRIES,
          },
        },
      }),
      this.linkModel.findOneAndUpdate(
        { transferId: transfer._id },
        { expiresAt: newExpiry, status: 'active' },
      ),
    ]);

    return { expiresAt: newExpiry };
  }

  /* ═════════════════════════════
     ADMIN — ALL TRANSFERS
  ═════════════════════════════ */
  async getAdminAll(dto: ListTransfersDto) {
    await this.syncExpiredTransfers();

    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const skip = (page - 1) * limit;
    const filter: Record<string, unknown> = {};
    if (dto.status && dto.status !== 'all') filter.status = dto.status;

    const [transfers, total] = await Promise.all([
      this.transferModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-passwordHash -viewerDetails -activity')
        .populate('senderId', 'name email')
        .populate(
          'linkId',
          'shortCode url status views downloads expiresAt hasPassword',
        )
        .lean(),
      this.transferModel.countDocuments(filter),
    ]);

    return {
      transfers: transfers.map((t) => this.formatTransfer(t)),
      total,
      page,
      limit,
    };
  }

  /* ═════════════════════════════
     ADMIN — STATS
  ═════════════════════════════ */
  async getAdminStats() {
    await this.syncExpiredTransfers();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [
      total,
      active,
      expired,
      disabled,
      sizeResult,
      engagementResult,
      transfersToday,
      downloadsToday,
    ] = await Promise.all([
      this.transferModel.countDocuments(),
      this.transferModel.countDocuments({ status: 'active' }),
      this.transferModel.countDocuments({ status: 'expired' }),
      this.transferModel.countDocuments({ status: 'disabled' }),
      this.transferModel.aggregate<{ total: number }>([
        { $group: { _id: null, total: { $sum: '$totalSize' } } },
      ]),
      this.transferModel.aggregate<{
        totalDownloads: number;
        totalViews: number;
      }>([
        {
          $group: {
            _id: null,
            totalDownloads: { $sum: { $ifNull: ['$downloads', 0] } },
            totalViews: { $sum: { $ifNull: ['$views', 0] } },
          },
        },
      ]),
      this.transferModel.countDocuments({ createdAt: { $gte: startOfToday } }),
      this.transferModel.aggregate<{ total: number }>([
        { $unwind: '$activity' },
        {
          $match: {
            'activity.action': 'download',
            'activity.createdAt': { $gte: startOfToday },
          },
        },
        { $count: 'total' },
      ]),
    ]);

    const engagement = engagementResult[0] ?? {
      totalDownloads: 0,
      totalViews: 0,
    };

    return {
      total,
      totalTransfers: total,
      active,
      expired,
      disabled,
      totalSize: sizeResult[0]?.total ?? 0,
      totalDownloads: engagement.totalDownloads,
      totalViews: engagement.totalViews,
      transfersToday,
      downloadsToday: downloadsToday[0]?.total ?? 0,
    };
  }

  /* ═════════════════════════════
     PUBLIC VIEW (unauthenticated)
  ═════════════════════════════ */
  async publicView(
    shortCode: string,
    viewerInfo: ViewerInfo,
    password?: string,
  ) {
    const link = await this.linkModel.findOne({ shortCode });
    if (!link) throw new NotFoundException('Link not found');
    if (link.status === 'disabled')
      throw new ForbiddenException('This link has been disabled');
    if (
      link.status === 'expired' ||
      (link.expiresAt && link.expiresAt < new Date())
    ) {
      await Promise.all([
        this.linkModel.findByIdAndUpdate(link._id, { status: 'expired' }),
        link.transferId
          ? this.transferModel.findByIdAndUpdate(link.transferId, {
              status: 'expired',
            })
          : Promise.resolve(null),
      ]);
      throw new ForbiddenException('This link has expired');
    }

    const transfer = await this.transferModel
      .findById(link.transferId)
      .select('+passwordHash');
    if (!transfer) throw new NotFoundException('Transfer not found');

    if (transfer.hasPassword) {
      if (!password) throw new ForbiddenException('Password required');
      const ok = await bcrypt.compare(password, transfer.passwordHash ?? '');
      if (!ok) throw new ForbiddenException('Incorrect password');
    }

    const now = new Date();

    await this.transferModel.findByIdAndUpdate(transfer._id, {
      $inc: { views: 1 },
      $set: { lastViewedAt: now },
      $push: {
        viewerDetails: {
          $each: [
            {
              viewId: uuidv4(),
              ip: viewerInfo.ip,
              device: viewerInfo.device,
              browser: viewerInfo.browser,
              os: viewerInfo.os,
              location: viewerInfo.location,
              viewedAt: now,
              action: 'view',
            },
          ],
          $slice: -MAX_VIEWER_ENTRIES,
        },
        activity: {
          $each: [
            {
              activityId: uuidv4(),
              action: 'view',
              description: `Anonymous viewed the transfer from ${viewerInfo.location ?? 'unknown location'}`,
              ip: viewerInfo.ip,
              location: viewerInfo.location,
              createdAt: now,
            },
          ],
          $slice: -MAX_ACTIVITY_ENTRIES,
        },
      },
    });

    await this.linkModel.findByIdAndUpdate(link._id, {
      $inc: { views: 1 },
      $set: { lastViewedAt: now },
    });
    this.notifyTransferAccess(
      transfer,
      NotificationType.TRANSFER_VIEWED,
      viewerInfo,
    ).catch(() => undefined);

    return this.formatTransfer(transfer.toObject());
  }

  /* ═════════════════════════════
     PUBLIC DOWNLOAD FILE (unauthenticated)
  ═════════════════════════════ */
  async publicDownloadFile(
    shortCode: string,
    fileId: string,
    password: string | undefined,
    viewerInfo: ViewerInfo,
  ) {
    const link = await this.linkModel.findOne({ shortCode });
    if (!link) throw new NotFoundException('Link not found');
    if (link.status === 'disabled')
      throw new ForbiddenException('This link has been disabled');
    if (
      link.status === 'expired' ||
      (link.expiresAt && link.expiresAt < new Date())
    ) {
      await Promise.all([
        this.linkModel.findByIdAndUpdate(link._id, { status: 'expired' }),
        link.transferId
          ? this.transferModel.findByIdAndUpdate(link.transferId, {
              status: 'expired',
            })
          : Promise.resolve(null),
      ]);
      throw new ForbiddenException('This link has expired');
    }

    const transfer = await this.transferModel
      .findById(link.transferId)
      .select('+passwordHash');
    if (!transfer) throw new NotFoundException('Transfer not found');

    if (transfer.hasPassword) {
      if (!password) throw new ForbiddenException('Password required');
      const ok = await bcrypt.compare(password, transfer.passwordHash ?? '');
      if (!ok) throw new ForbiddenException('Incorrect password');
    }

    /* Fixed: ObjectId.toString() === string comparison */
    const file = transfer.files.find((f) => f.fileId?.toString() === fileId);
    if (!file) throw new NotFoundException('File not found in this transfer');

    const downloadUrl = await this.r2Service.generatePresignedDownloadUrl(
      file.key,
      file.originalName,
    );

    const now = new Date();
    await this.transferModel.findByIdAndUpdate(transfer._id, {
      $inc: { downloads: 1 },
      $set: { lastDownloadedAt: now },
      $push: {
        viewerDetails: {
          $each: [
            {
              viewId: uuidv4(),
              ip: viewerInfo.ip,
              device: viewerInfo.device,
              browser: viewerInfo.browser,
              os: viewerInfo.os,
              location: viewerInfo.location,
              viewedAt: now,
              downloadedAt: now,
              action: 'download',
            },
          ],
          $slice: -MAX_VIEWER_ENTRIES,
        },
        activity: {
          $each: [
            {
              activityId: uuidv4(),
              action: 'download',
              description: `Anonymous downloaded "${file.originalName}" from ${viewerInfo.location ?? 'unknown location'}`,
              ip: viewerInfo.ip,
              location: viewerInfo.location,
              createdAt: now,
            },
          ],
          $slice: -MAX_ACTIVITY_ENTRIES,
        },
      },
    });

    await this.linkModel.findByIdAndUpdate(link._id, {
      $inc: { downloads: 1 },
      $set: { lastDownloadedAt: now },
    });
    this.notifyTransferAccess(
      transfer,
      NotificationType.TRANSFER_DOWNLOADED,
      viewerInfo,
      {
        fileId,
        fileName: file.originalName,
        totalSize: file.size,
        downloadedAt: now,
      },
    ).catch(() => undefined);

    return { downloadUrl, fileName: file.originalName, size: file.size };
  }

  /* ═════════════════════════════
     STREAM ALL FILES AS ZIP (unauthenticated)
     Preserves folder structure via relativePath stored on each TransferFile.
  ═════════════════════════════ */
  async streamAllAsZip(
    shortCode: string,
    password: string | undefined,
    viewerInfo: ViewerInfo,
    res: Response,
    /** When set, only files whose relativePath starts with this prefix are included */
    folderPath?: string,
  ): Promise<void> {
    const link = await this.linkModel.findOne({ shortCode });
    if (!link) throw new NotFoundException('Link not found');
    if (link.status === 'disabled')
      throw new ForbiddenException('This link has been disabled');
    if (
      link.status === 'expired' ||
      (link.expiresAt && link.expiresAt < new Date())
    ) {
      await Promise.all([
        this.linkModel.findByIdAndUpdate(link._id, { status: 'expired' }),
        link.transferId
          ? this.transferModel.findByIdAndUpdate(link.transferId, {
              status: 'expired',
            })
          : Promise.resolve(null),
      ]);
      throw new ForbiddenException('This link has expired');
    }

    const transfer = await this.transferModel
      .findById(link.transferId)
      .select('+passwordHash');
    if (!transfer) throw new NotFoundException('Transfer not found');

    if (transfer.hasPassword) {
      if (!password) throw new ForbiddenException('Password required');
      const ok = await bcrypt.compare(password, transfer.passwordHash ?? '');
      if (!ok) throw new ForbiddenException('Incorrect password');
    }

    /* Filter to folder subset when folderPath is provided */
    const normalizedFolder = this.normalizeFolderPath(folderPath);

    const filesToZip = normalizedFolder
      ? transfer.files.filter((f) => {
          const rp = this.safeZipEntryPath(f.relativePath, f.originalName);
          return (
            rp.startsWith(normalizedFolder) ||
            rp === normalizedFolder.slice(0, -1)
          );
        })
      : transfer.files;

    if (filesToZip.length === 0) {
      res.status(404).json({
        success: false,
        message: 'No files found for the specified folder',
      });
      return;
    }

    const zipName = normalizedFolder
      ? (normalizedFolder.split('/').filter(Boolean).pop() ?? 'folder')
      : (transfer.title ?? 'transfer');
    const safeTitle = zipName.replace(/[^\w\s-]/g, '_').trim();

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeTitle}.zip"`,
    );

    const archive = archiver.create('zip', { zlib: { level: 0 } });

    archive.on('error', (err: Error) => {
      this.logger.error(
        `ZIP stream error for transfer ${transfer._id}: ${err.message}`,
      );
    });

    archive.pipe(res as any);

    for (const file of filesToZip) {
      try {
        const stream = await this.r2Service.getObjectStream(file.key);
        /* Strip the folder prefix from entry names so the ZIP root is the folder itself */
        const fullPath = this.safeZipEntryPath(
          file.relativePath,
          file.originalName,
        );
        const entryName =
          normalizedFolder && fullPath.startsWith(normalizedFolder)
            ? fullPath.slice(normalizedFolder.length)
            : fullPath;
        archive.append(stream as any, { name: entryName || file.originalName });
      } catch (err) {
        this.logger.error(
          `ZIP: failed to stream file "${file.originalName}": ${(err as Error).message}`,
        );
      }
    }

    await archive.finalize();

    const now = new Date();
    await this.transferModel.findByIdAndUpdate(transfer._id, {
      $inc: { downloads: 1 },
      $set: { lastDownloadedAt: now },
      $push: {
        activity: {
          $each: [
            {
              activityId: uuidv4(),
              action: 'download',
              description: normalizedFolder
                ? `Anonymous downloaded folder "${zipName}" (${filesToZip.length} file(s)) as ZIP from ${viewerInfo.location ?? 'unknown location'}`
                : `Anonymous downloaded all ${filesToZip.length} file(s) as ZIP from ${viewerInfo.location ?? 'unknown location'}`,
              ip: viewerInfo.ip,
              location: viewerInfo.location,
              createdAt: now,
            },
          ],
          $slice: -MAX_ACTIVITY_ENTRIES,
        },
      },
    });

    await this.linkModel.findByIdAndUpdate(link._id, {
      $inc: { downloads: 1 },
      $set: { lastDownloadedAt: now },
    });
    this.notifyTransferAccess(
      transfer,
      NotificationType.TRANSFER_DOWNLOADED,
      viewerInfo,
      {
        fileCount: filesToZip.length,
        totalSize: filesToZip.reduce((sum, file) => sum + file.size, 0),
        folderPath: normalizedFolder ?? null,
        zipName,
        downloadedAt: now,
      },
    ).catch(() => undefined);
  }

  /* ─── helpers ─── */

  private folderFullPath(folder: Pick<Folder, 'path' | 'name'>): string {
    return `${folder.path}${folder.name}/`;
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private normalizeRelativePath(
    path: string | null | undefined,
    fallbackName: string,
  ): string | null {
    if (!path) return null;

    const cleaned = path
      .replace(/\\/g, '/')
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean);

    if (cleaned.length <= 1) return null;
    if (cleaned.some((part) => part === '.' || part === '..')) return null;

    const fallbackLeaf = fallbackName.trim();
    if (fallbackLeaf && cleaned[cleaned.length - 1] !== fallbackLeaf) {
      cleaned[cleaned.length - 1] = fallbackLeaf;
    }

    return cleaned.join('/');
  }

  private safeZipEntryPath(
    path: string | null | undefined,
    fallbackName: string,
  ): string {
    return (
      this.normalizeRelativePath(path, fallbackName) ??
      fallbackName.replace(/[/\\]/g, '_')
    );
  }

  private normalizeFolderPath(path: string | null | undefined): string | null {
    if (!path) return null;
    const parts = path
      .replace(/\\/g, '/')
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length === 0) return null;
    if (parts.some((part) => part === '.' || part === '..')) return null;

    return `${parts.join('/')}/`;
  }

  private buildFolderSnapshots(
    files: TransferFileSnapshot[],
    pathToFolderIdMap?: Map<string, string>,
  ) {
    const byPath = new Map<
      string,
      {
        folderId: Types.ObjectId;
        name: string;
        path: string;
        fileCount: number;
        size: number;
      }
    >();

    for (const file of files) {
      const relativePath = file.relativePath;
      if (!relativePath?.includes('/')) continue;

      const parts = relativePath.split('/').filter(Boolean);
      for (let i = 1; i < parts.length; i++) {
        const dirPath = parts.slice(0, i).join('/');
        const existing = byPath.get(dirPath);
        if (existing) {
          existing.fileCount += 1;
          existing.size += file.size ?? 0;
          continue;
        }

        /* Prefer the real Folder._id from the map; fall back to synthetic only
           when the path isn't matched (e.g. fileKeys fallback path). */
        const realId = pathToFolderIdMap?.get(dirPath);
        byPath.set(dirPath, {
          folderId: realId ? new Types.ObjectId(realId) : new Types.ObjectId(),
          name: parts[i - 1],
          path: `/${dirPath}/`,
          fileCount: 1,
          size: file.size ?? 0,
        });
      }
    }

    return Array.from(byPath.values()).sort((a, b) =>
      a.path.localeCompare(b.path),
    );
  }

  /** Cryptographically secure 8-char alphanumeric short code */
  private generateShortCode(): string {
    const chars =
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = crypto.randomBytes(8);
    let code = '';
    for (const byte of bytes) {
      code += chars[byte % chars.length];
    }
    return code;
  }

  private generateQrCodeUrl(url: string): string {
    return `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(url)}`;
  }

  private buildRecipientQuery(userId: string, userEmail?: string) {
    return { $in: [...new Set([userId, userEmail].filter(Boolean))] };
  }

  private formatTransfer(t: any, viewerId?: string) {
    const isStarred = viewerId
      ? (t.starredBy ?? []).some((id: any) => id?.toString() === viewerId)
      : false;
    const populatedSender =
      t.senderId && typeof t.senderId === 'object' ? t.senderId : null;
    const populatedLink =
      t.linkId &&
      typeof t.linkId === 'object' &&
      ('shortCode' in t.linkId || 'url' in t.linkId)
        ? t.linkId
        : null;

    return {
      id: t._id?.toString() ?? t.id,
      senderId:
        populatedSender?._id?.toString?.() ??
        t.senderId?.toString?.() ??
        t.senderId,
      sender:
        populatedSender && (populatedSender.name || populatedSender.email)
          ? {
              id: populatedSender._id?.toString(),
              name: populatedSender.name,
              email: populatedSender.email,
            }
          : undefined,
      method: t.method,
      title: t.title,
      subject: t.subject,
      message: t.message,
      files: (t.files ?? []).map((f: any) => ({
        id: f.fileId?.toString() ?? f._id?.toString(),
        name: f.originalName,
        size: f.size,
        mimeType: f.mimeType,
        extension: f.extension,
        key: f.key,
        relativePath: f.relativePath ?? null,
      })),
      folders: (t.folders ?? []).map((folder: any) => ({
        id: folder.folderId?.toString(),
        name: folder.name,
        path: folder.path ?? '/',
        fileCount: folder.fileCount ?? 0,
        size: folder.size ?? 0,
      })),
      totalSize: t.totalSize,
      fileCount: t.fileCount,
      folderCount: t.folderCount ?? 0,
      recipients: t.recipients ?? [],
      privacy: t.privacy,
      status: t.status,
      expiresAt: t.expiresAt,
      hasPassword: t.hasPassword,
      views: t.views ?? 0,
      downloads: t.downloads ?? 0,
      lastViewedAt: t.lastViewedAt,
      lastDownloadedAt: t.lastDownloadedAt,
      linkId: populatedLink?._id?.toString() ?? t.linkId?.toString?.() ?? null,
      link: populatedLink
        ? this.formatTransferLink(populatedLink, t._id)
        : null,
      isStarred,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  private formatTransferLink(link: any, transferId?: any) {
    return {
      id: link._id?.toString() ?? link.id,
      transferId: link.transferId?.toString?.() ?? transferId?.toString?.(),
      url: link.url,
      qrCodeUrl: link.qrCodeUrl,
      shortCode: link.shortCode,
      status: link.status,
      views: link.views ?? 0,
      downloads: link.downloads ?? 0,
      lastViewedAt: link.lastViewedAt,
      lastDownloadedAt: link.lastDownloadedAt,
      expiresAt: link.expiresAt,
      hasPassword: link.hasPassword,
      privacy: link.privacy,
      fileCount: link.fileCount ?? 0,
      totalSize: link.totalSize ?? 0,
      createdAt: link.createdAt,
    };
  }
}
