import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { FileRecord, FileDocument } from './schemas/file.schema';
import { Share } from '../shares/schemas/share.schema';
import { User } from '../users/schemas/user.schema';
import { Folder } from '../folders/schemas/folder.schema';
import {
  SaveFileMetadataDto,
  FileQueryDto,
  RenameFileDto,
  UpdateFileDto,
  BulkDeleteDto,
  BulkRestoreDto,
  BulkMoveDto,
} from './dto/file.dto';

import { R2Service } from '../r2/r2.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/schemas/notification.schema';
import { Role, ShareType, ResourceType } from '../common/enums';

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    @InjectModel(FileRecord.name)
    private readonly fileModel: Model<FileDocument>,
    @InjectModel(Share.name)
    private readonly shareModel: Model<any>,
    @InjectModel(User.name)
    private readonly userModel: Model<any>,
    @InjectModel(Folder.name)
    private readonly folderModel: Model<any>,
    private readonly r2Service: R2Service,
    private readonly notificationsService: NotificationsService,
  ) {}

  /* =========================
     NORMALISE LEAN FILE
  ========================= */
  private toFileDto(raw: any): any {
    const id = raw._id?.toString() ?? raw.id ?? '';
    const name = raw.fileName ?? raw.name ?? '';
    const ext =
      (raw.originalName ?? raw.fileName ?? '')
        .split('.')
        .pop()
        ?.toLowerCase() ?? '';
    const owner =
      raw.uploadedBy && typeof raw.uploadedBy === 'object'
        ? {
            id: raw.uploadedBy._id?.toString() ?? raw.uploadedBy.id,
            name: raw.uploadedBy.name,
            email: raw.uploadedBy.email,
            role: raw.uploadedBy.role,
          }
        : raw.owner;
    return {
      ...raw,
      id,
      name,
      extension: ext,
      isTrashed: raw.isDeleted ?? false,
      isShared: (raw.sharedWith?.length ?? 0) > 0,
      owner,
      ownerId: owner?.id ?? raw.uploadedBy?.toString?.() ?? raw.ownerId ?? id,
    };
  }

  private getCategoryFilter(category?: FileQueryDto['category']): any | null {
    switch (category) {
      case 'image':
        return {
          $or: [
            { mimeType: { $regex: '^image/', $options: 'i' } },
            {
              originalName: {
                $regex: '\\.(jpg|jpeg|png|gif|webp|svg|bmp|heic)$',
                $options: 'i',
              },
            },
          ],
        };
      case 'video':
        return {
          $or: [
            { mimeType: { $regex: '^video/', $options: 'i' } },
            {
              originalName: {
                $regex: '\\.(mp4|mov|avi|mkv|webm|m4v)$',
                $options: 'i',
              },
            },
          ],
        };
      case 'spreadsheet':
        return {
          $or: [
            { mimeType: { $regex: 'spreadsheet|excel|csv', $options: 'i' } },
            {
              originalName: { $regex: '\\.(xls|xlsx|csv|ods)$', $options: 'i' },
            },
          ],
        };
      case 'document':
        return {
          $or: [
            {
              mimeType: {
                $regex: 'pdf|word|document|text/|presentation|powerpoint',
                $options: 'i',
              },
            },
            {
              originalName: {
                $regex: '\\.(pdf|doc|docx|txt|rtf|ppt|pptx|pages|odt)$',
                $options: 'i',
              },
            },
          ],
        };
      case 'other':
        return {
          $nor: [
            { mimeType: { $regex: '^image/', $options: 'i' } },
            {
              originalName: {
                $regex: '\\.(jpg|jpeg|png|gif|webp|svg|bmp|heic)$',
                $options: 'i',
              },
            },
            { mimeType: { $regex: '^video/', $options: 'i' } },
            {
              originalName: {
                $regex: '\\.(mp4|mov|avi|mkv|webm|m4v)$',
                $options: 'i',
              },
            },
            { mimeType: { $regex: 'spreadsheet|excel|csv', $options: 'i' } },
            {
              originalName: { $regex: '\\.(xls|xlsx|csv|ods)$', $options: 'i' },
            },
            {
              mimeType: {
                $regex: 'pdf|word|document|text/|presentation|powerpoint',
                $options: 'i',
              },
            },
            {
              originalName: {
                $regex: '\\.(pdf|doc|docx|txt|rtf|ppt|pptx|pages|odt)$',
                $options: 'i',
              },
            },
          ],
        };
      default:
        return null;
    }
  }

  /* =========================
     SAVE FILE METADATA
  ========================= */
  async saveMetadata(
    dto: SaveFileMetadataDto,
    userId: string,
    organizationId?: string | null,
  ) {
    const { fileId, fileName, ...rest } = dto;
    const ownerId = new Types.ObjectId(userId);
    const expectedKeyPrefix = `uploads/${userId}/`;
    if (!dto.key.startsWith(expectedKeyPrefix)) {
      throw new ForbiddenException(
        'The uploaded object does not belong to the current user',
      );
    }

    // Finalization is deliberately idempotent. A browser may retry this request
    // after a timeout; that must return the canonical FileRecord instead of
    // creating a duplicate or failing on the unique storage key.
    const existing = await this.fileModel.findOne({
      key: dto.key,
      uploadedBy: ownerId,
    });
    if (existing) return existing.populate('uploadedBy', 'name email');

    const objectMetadata = await this.r2Service.getObjectMetadata(dto.key);
    if (!objectMetadata) {
      throw new BadRequestException(
        'Upload is not complete in storage. Finish the upload before saving or sending it.',
      );
    }
    if (objectMetadata.size !== dto.size) {
      throw new BadRequestException(
        `Uploaded file size mismatch: expected ${dto.size} bytes, found ${objectMetadata.size} bytes`,
      );
    }

    const folderId = await this.verifyWritableFolder(dto.folderId, userId);
    const file = await this.fileModel.create({
      ...rest,
      ...(fileId ? { _id: new Types.ObjectId(fileId) } : {}),
      fileName: fileName ?? dto.originalName,
      uploadedBy: ownerId,
      organizationId: organizationId
        ? new Types.ObjectId(organizationId)
        : null,
      folderId,
      uploadSessionId: dto.uploadSessionId
        ? new Types.ObjectId(dto.uploadSessionId)
        : null,
      tags: dto.tags?.map((t) => t.toLowerCase().trim()) ?? [],
      status: 'active',
    });

    this.notifyFileUploaded(file, userId, organizationId).catch(
      () => undefined,
    );

    return file.populate('uploadedBy', 'name email');
  }

  /* =========================
     BATCH SAVE METADATA
  ========================= */
  async saveBatchMetadata(
    files: SaveFileMetadataDto[],
    userId: string,
    organizationId?: string | null,
  ) {
    if (new Set(files.map((file) => file.key)).size !== files.length) {
      throw new BadRequestException('Duplicate storage keys were provided');
    }

    // Keep folder finalization bounded for very large directory uploads while
    // reusing the ownership, storage verification and idempotency guarantees of
    // the single-file finalizer.
    const saved: FileDocument[] = [];
    const concurrency = 10;
    for (let offset = 0; offset < files.length; offset += concurrency) {
      const chunk = files.slice(offset, offset + concurrency);
      const results = await Promise.all(
        chunk.map((dto) => this.saveMetadata(dto, userId, organizationId)),
      );
      saved.push(...results);
    }
    this.logger.log(`Batch saved ${saved.length} files | user=${userId}`);
    return saved;
  }

  private async notifyFileUploaded(
    file: any,
    userId: string,
    organizationId?: string | null,
  ) {
    await this.notificationsService.create({
      userId,
      organizationId: organizationId ?? null,
      type: NotificationType.FILE_UPLOADED,
      title: 'File uploaded',
      message: `"${file.fileName ?? file.originalName}" was uploaded successfully.`,
      targetType: 'file',
      targetId: file._id.toString(),
      fileId: file._id.toString(),
      metadata: {
        fileName: file.fileName,
        originalName: file.originalName,
        mimeType: file.mimeType,
        size: file.size,
      },
    });
  }

  private async notifyFilesUploaded(
    files: any[],
    userId: string,
    organizationId?: string | null,
  ) {
    if (files.length === 0) return;
    if (files.length === 1) {
      await this.notifyFileUploaded(files[0], userId, organizationId);
      return;
    }

    const totalSize = files.reduce((sum, file) => sum + (file.size ?? 0), 0);
    await this.notificationsService.create({
      userId,
      organizationId: organizationId ?? null,
      type: NotificationType.FILE_UPLOADED,
      title: 'Files uploaded',
      message: `${files.length} files were uploaded successfully.`,
      metadata: {
        fileCount: files.length,
        totalSize,
        fileIds: files.map((file) => file._id.toString()),
      },
    });
  }

  /* =========================
     LIST FILES
  ========================= */
  async findAll(currentUser: any, query: FileQueryDto) {
    const isSuperadmin = currentUser.role === Role.SUPERADMIN;
    const andConditions: any[] = [{ isDeleted: false }];
    const folderId = this.normalizeOptionalId(query.folderId);

    if (!isSuperadmin) {
      andConditions.push({ uploadedBy: this.oid(this.uid(currentUser)) });
    }

    if (folderId) {
      if (!Types.ObjectId.isValid(folderId)) {
        throw new BadRequestException('Invalid folder ID');
      }
      andConditions.push({ folderId: new Types.ObjectId(folderId) });
    } else if (query.category && !query.includeFolderFiles) {
      andConditions.push({ folderId: null });
    }

    if (query.search) {
      andConditions.push({
        $or: [
          { fileName: { $regex: query.search, $options: 'i' } },
          { originalName: { $regex: query.search, $options: 'i' } },
        ],
      });
    }

    if (query.mimeType) {
      const escaped = query.mimeType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      andConditions.push({
        mimeType: { $regex: `^${escaped}`, $options: 'i' },
      });
    }

    const categoryFilter = this.getCategoryFilter(query.category);
    if (categoryFilter) {
      andConditions.push(categoryFilter);
    }

    if (query.tag) {
      andConditions.push({ tags: query.tag.toLowerCase().trim() });
    }

    if (query.uploadedBy && isSuperadmin) {
      if (!Types.ObjectId.isValid(query.uploadedBy)) {
        throw new BadRequestException('Invalid uploadedBy ID');
      }
      andConditions.push({ uploadedBy: new Types.ObjectId(query.uploadedBy) });
    }

    if (query.ownerRole && isSuperadmin) {
      const ownerIds = await this.userModel.distinct('_id', {
        role: query.ownerRole,
      });
      andConditions.push({ uploadedBy: { $in: ownerIds } });
    }

    const filter =
      andConditions.length > 1 ? { $and: andConditions } : andConditions[0];

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 20);
    const skip = (page - 1) * limit;

    const allowedSortFields = [
      'createdAt',
      'updatedAt',
      'fileName',
      'size',
      'downloadCount',
      'lastAccessedAt',
    ];
    const sortBy = allowedSortFields.includes(query.sortBy)
      ? query.sortBy
      : 'createdAt';
    const sortOrder = query.sortOrder === 'asc' ? 1 : -1;

    const [files, total] = await Promise.all([
      this.fileModel
        .find(filter)
        .populate('uploadedBy', 'name email role')
        .populate('folderId', 'name path')
        .sort({ [sortBy]: sortOrder })
        .skip(skip)
        .limit(limit)
        .lean(),

      this.fileModel.countDocuments(filter),
    ]);

    return {
      files: files.map((f) => this.toFileDto(f)),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  /* =========================
     GET ONE FILE
  ========================= */
  async findOne(fileId: string, currentUser: any) {
    return this.findOneAndVerifyAccess(fileId, currentUser);
  }

  async findOneWithDownloadUrl(fileId: string, currentUser: any) {
    const file = await this.findOneAndVerifyAccess(fileId, currentUser);

    await this.fileModel.findByIdAndUpdate(fileId, {
      $inc: { downloadCount: 1 },
      lastAccessedAt: new Date(),
    });

    const downloadUrl = await this.r2Service.generatePresignedDownloadUrl(
      file.key,
      file.originalName,
    );

    return { file, downloadUrl };
  }

  async findOneWithViewUrl(fileId: string, currentUser: any) {
    const file = await this.findOneAndVerifyAccess(fileId, currentUser);

    await this.fileModel.findByIdAndUpdate(fileId, {
      lastAccessedAt: new Date(),
    });

    const viewUrl = await this.r2Service.generatePresignedViewUrl(file.key);
    return { file, viewUrl };
  }

  /* =========================
     UPDATE FILE (description / tags)
  ========================= */
  async updateFile(fileId: string, dto: UpdateFileDto, currentUser: any) {
    const file = await this.findOneAndVerifyAccess(fileId, currentUser);
    this.assertOwnerOrAdmin(file, currentUser);

    const updates: Record<string, any> = {};
    if (dto.description !== undefined)
      updates.description = dto.description ?? null;
    if (dto.tags !== undefined)
      updates.tags = dto.tags.map((t) => t.toLowerCase().trim());

    if (!Object.keys(updates).length) {
      return this.toFileDto((file as any).toObject?.() ?? file);
    }

    const updated = await this.fileModel
      .findByIdAndUpdate(fileId, updates, { new: true })
      .populate('uploadedBy', 'name email')
      .lean();

    return this.toFileDto(updated);
  }

  /* =========================
     SOFT DELETE
  ========================= */
  async softDelete(fileId: string, currentUser: any) {
    const file = await this.findOneAndVerifyAccess(fileId, currentUser);
    this.assertOwnerOrAdmin(file, currentUser);

    await this.fileModel.findByIdAndUpdate(fileId, {
      isDeleted: true,
      status: 'trashed',
      deletedAt: new Date(),
      deletedBy: currentUser._id,
    });

    const ownerStr = file.uploadedBy.toString();
    if (ownerStr !== currentUser._id.toString()) {
      this.notificationsService
        .create({
          userId: ownerStr,
          type: NotificationType.FILE_DELETED,
          title: 'Your file was moved to trash',
          message: `"${file.fileName ?? file.originalName}" was moved to trash by an administrator.`,
          fileId,
          metadata: { deletedBy: currentUser.name ?? currentUser.email },
        })
        .catch(() => undefined);
    }

    return { message: 'File moved to trash. Auto-deleted after 7 days.' };
  }

  /* =========================
     PERMANENT DELETE
  ========================= */
  async permanentDelete(fileId: string, currentUser: any) {
    if (!Types.ObjectId.isValid(fileId))
      throw new BadRequestException('Invalid file ID');

    const file = await this.fileModel.findById(fileId);
    if (!file) throw new NotFoundException('File not found');

    this.assertOwnerOrAdmin(file, currentUser);

    await this.r2Service.deleteObject(file.key);
    await this.fileModel.findByIdAndDelete(fileId);

    return { message: 'File permanently deleted' };
  }

  async permanentlyDeleteAllForUser(userId: string): Promise<number> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException('Invalid user ID');
    }

    const files = await this.fileModel
      .find({ uploadedBy: new Types.ObjectId(userId) })
      .select('_id key')
      .lean()
      .exec();

    for (const file of files) {
      await this.r2Service.deleteObject(file.key);
    }

    await this.fileModel.deleteMany({ uploadedBy: new Types.ObjectId(userId) });
    return files.length;
  }

  /* =========================
     RESTORE FROM TRASH
  ========================= */
  async restore(fileId: string, currentUser: any) {
    if (!Types.ObjectId.isValid(fileId))
      throw new BadRequestException('Invalid file ID');

    const file = await this.fileModel.findOne({ _id: fileId, isDeleted: true });
    if (!file) throw new NotFoundException('File not found in trash');

    this.assertOwnerOrAdmin(file, currentUser);

    await this.fileModel.findByIdAndUpdate(fileId, {
      isDeleted: false,
      status: 'active',
      deletedAt: null,
      deletedBy: null,
    });

    const ownerStr = file.uploadedBy.toString();
    if (ownerStr !== currentUser._id.toString()) {
      this.notificationsService
        .create({
          userId: ownerStr,
          type: NotificationType.FILE_RESTORED,
          title: 'Your file has been restored',
          message: `"${file.fileName ?? file.originalName}" was restored from trash by an administrator.`,
          fileId,
          metadata: { restoredBy: currentUser.name ?? currentUser.email },
        })
        .catch(() => undefined);
    }

    return { message: 'File restored successfully' };
  }

  /* =========================
     RENAME
  ========================= */
  async rename(fileId: string, dto: RenameFileDto, currentUser: any) {
    const file = await this.findOneAndVerifyAccess(fileId, currentUser);
    this.assertOwnerOrAdmin(file, currentUser);

    return this.fileModel.findByIdAndUpdate(
      fileId,
      { fileName: dto.fileName.trim() },
      { new: true },
    );
  }

  /* =========================
     TRASH
  ========================= */
  async getTrash(currentUser: any) {
    const filter: any = { isDeleted: true };

    if (currentUser.role !== Role.SUPERADMIN) {
      filter.uploadedBy = this.oid(this.uid(currentUser));
    }

    const files = await this.fileModel
      .find(filter)
      .populate('uploadedBy', 'name email')
      .populate('deletedBy', 'name email')
      .sort({ deletedAt: -1 })
      .lean();

    return files.map((f) => this.toFileDto(f));
  }

  /* =========================
     SHARED WITH ME
  ========================= */
  async getSharedWithMe(currentUser: any): Promise<any[]> {
    const now = new Date();

    const userShares = await this.shareModel
      .find({
        resourceType: ResourceType.FILE,
        isActive: true,
        $and: [
          {
            $or: [
              { sharedWithUserIds: currentUser._id },
              { sharedWithUserIds: this.oid(this.uid(currentUser)) },
              { sharedWithEmails: currentUser.email?.toLowerCase() },
              { type: ShareType.LINK },
            ],
          },
          {
            $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
          },
        ],
      })
      .select('fileId permission type expiresAt viewCount downloadCount name');

    const fileIds = userShares.map((s) => s.fileId).filter(Boolean);
    if (!fileIds.length) return [];

    const files = await this.fileModel
      .find({ _id: { $in: fileIds }, isDeleted: false })
      .populate('uploadedBy', 'name email')
      .lean();

    const shareMap = new Map(userShares.map((s) => [s.fileId?.toString(), s]));

    return files.map((f) =>
      this.toFileDto({
        ...f,
        shareInfo: shareMap.get((f._id as any).toString()) ?? null,
      }),
    );
  }

  /* =========================
     BULK OPERATIONS
  ========================= */
  async bulkDelete(dto: BulkDeleteDto, currentUser: any) {
    const ids = dto.fileIds.map((id) => new Types.ObjectId(id));
    const now = new Date();

    const result = await this.fileModel.updateMany(
      {
        _id: { $in: ids },
        ...this.ownerFilter(currentUser),
        isDeleted: false,
      },
      {
        isDeleted: true,
        status: 'trashed',
        deletedAt: now,
        deletedBy: currentUser._id,
      },
    );

    return { message: `${result.modifiedCount} file(s) moved to trash` };
  }

  async bulkRestore(dto: BulkRestoreDto, currentUser: any) {
    const ids = dto.fileIds.map((id) => new Types.ObjectId(id));

    const result = await this.fileModel.updateMany(
      {
        _id: { $in: ids },
        ...this.ownerFilter(currentUser),
        isDeleted: true,
      },
      { isDeleted: false, status: 'active', deletedAt: null, deletedBy: null },
    );

    return { message: `${result.modifiedCount} file(s) restored` };
  }

  async bulkMove(dto: BulkMoveDto, currentUser: any) {
    const ids = dto.fileIds.map((id) => new Types.ObjectId(id));
    const folderId = await this.verifyWritableFolder(
      dto.folderId,
      currentUser._id.toString(),
      currentUser.role === Role.SUPERADMIN,
    );

    const result = await this.fileModel.updateMany(
      { _id: { $in: ids }, ...this.ownerFilter(currentUser) },
      { folderId },
    );

    return { message: `${result.modifiedCount} file(s) moved` };
  }

  /* =========================
     ADMIN STATS
  ========================= */
  async getAdminStats() {
    const [result] = await this.fileModel.aggregate([
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                totalSize: { $sum: '$size' },
                active: { $sum: { $cond: ['$isDeleted', 0, 1] } },
                trashed: { $sum: { $cond: ['$isDeleted', 1, 0] } },
                totalDownloads: { $sum: '$downloadCount' },
              },
            },
          ],
          byMimeCategory: [
            { $match: { isDeleted: false } },
            {
              $group: {
                _id: {
                  $switch: {
                    branches: [
                      {
                        case: {
                          $eq: [{ $substr: ['$mimeType', 0, 6] }, 'image/'],
                        },
                        then: 'image',
                      },
                      {
                        case: {
                          $eq: [{ $substr: ['$mimeType', 0, 6] }, 'video/'],
                        },
                        then: 'video',
                      },
                      {
                        case: {
                          $eq: [{ $substr: ['$mimeType', 0, 6] }, 'audio/'],
                        },
                        then: 'audio',
                      },
                      {
                        case: {
                          $eq: [{ $substr: ['$mimeType', 0, 5] }, 'text/'],
                        },
                        then: 'text',
                      },
                      {
                        case: {
                          $eq: [
                            { $substr: ['$mimeType', 0, 12] },
                            'application/',
                          ],
                        },
                        then: 'application',
                      },
                    ],
                    default: 'other',
                  },
                },
                count: { $sum: 1 },
                totalSize: { $sum: '$size' },
              },
            },
            { $sort: { count: -1 } },
          ],
          recentUploads: [
            { $match: { isDeleted: false } },
            { $sort: { createdAt: -1 } },
            { $limit: 5 },
            {
              $project: {
                fileName: 1,
                size: 1,
                mimeType: 1,
                createdAt: 1,
                uploadedBy: 1,
              },
            },
          ],
        },
      },
    ]);

    const t = result.totals[0] ?? {
      total: 0,
      totalSize: 0,
      active: 0,
      trashed: 0,
      totalDownloads: 0,
    };

    return {
      total: t.total,
      active: t.active,
      trashed: t.trashed,
      totalSizeBytes: t.totalSize,
      totalSizeMB: Math.round((t.totalSize / (1024 * 1024)) * 100) / 100,
      totalDownloads: t.totalDownloads,
      byMimeCategory: result.byMimeCategory,
      recentUploads: result.recentUploads,
    };
  }

  /* =========================
     CRON: DELETE EXPIRED SOFT-DELETED FILES
  ========================= */
  async permanentlyDeleteExpired(retentionDays: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    let deletedCount = 0;
    const batchSize = 100;

    while (true) {
      const batch = await this.fileModel
        .find({ isDeleted: true, deletedAt: { $lte: cutoff } })
        .limit(batchSize)
        .lean();

      if (!batch.length) break;

      for (const file of batch) {
        try {
          await this.r2Service.deleteObject(file.key);
          await this.fileModel.findByIdAndDelete(file._id);
          deletedCount++;
        } catch (err) {
          this.logger.error(
            `Cron: failed deleting file ${file._id}: ${(err as Error).message}`,
          );
        }
      }
    }

    return deletedCount;
  }

  /* =========================
     PRIVATE HELPERS
  ========================= */
  private async findOneAndVerifyAccess(
    fileId: string,
    currentUser: any,
  ): Promise<FileDocument> {
    if (!Types.ObjectId.isValid(fileId)) {
      throw new BadRequestException('Invalid file ID');
    }

    const file = await this.fileModel.findById(fileId);

    if (!file || file.isDeleted) {
      throw new NotFoundException('File not found');
    }

    const isOwner = file.uploadedBy.toString() === currentUser._id.toString();
    const isAdmin = currentUser.role === Role.SUPERADMIN;

    if (isOwner || isAdmin) return file;

    const isLegacyShared = file.sharedWith?.some(
      (id) => id.toString() === currentUser._id.toString(),
    );
    if (isLegacyShared) return file;

    const now = new Date();
    const activeShare = await this.shareModel.findOne({
      fileId: file._id,
      isActive: true,
      $and: [
        {
          $or: [
            { type: ShareType.LINK },
            { sharedWithUserIds: currentUser._id },
            { sharedWithEmails: currentUser.email?.toLowerCase() },
          ],
        },
        { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
      ],
    });

    if (!activeShare) {
      throw new ForbiddenException('You do not have access to this file');
    }

    return file;
  }

  private assertOwnerOrAdmin(file: FileDocument, currentUser: any): void {
    const isOwner = file.uploadedBy.toString() === currentUser._id.toString();
    const isAdmin = currentUser.role === Role.SUPERADMIN;
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException(
        'Only the file owner or a superadmin can perform this action',
      );
    }
  }

  private ownerFilter(currentUser: any): Record<string, unknown> {
    return currentUser.role === Role.SUPERADMIN
      ? {}
      : { uploadedBy: this.oid(this.uid(currentUser)) };
  }

  private uid(user: any): string {
    const id = (user._id ?? user.userId ?? user.id)?.toString();
    if (!id) throw new BadRequestException('Invalid user');
    return id;
  }

  private oid(id: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(id))
      throw new BadRequestException('Invalid ID');
    return new Types.ObjectId(id);
  }

  private normalizeOptionalId(value?: string): string | undefined {
    if (!value || value === 'null' || value === 'undefined') return undefined;
    return value;
  }

  private async verifyWritableFolder(
    folderId: string | undefined,
    userId: string,
    allowAnyOwner = false,
  ): Promise<Types.ObjectId | null> {
    if (!folderId) return null;
    if (!Types.ObjectId.isValid(folderId)) {
      throw new BadRequestException('Invalid folder ID');
    }

    const folder = await this.folderModel
      .findOne({
        _id: new Types.ObjectId(folderId),
        ...(allowAnyOwner ? {} : { createdBy: new Types.ObjectId(userId) }),
        isDeleted: false,
      })
      .select('_id')
      .lean<{ _id: Types.ObjectId }>();

    if (!folder) {
      throw new ForbiddenException(
        'You can only upload files to your own folders',
      );
    }

    return folder._id as Types.ObjectId;
  }

  private async verifyWritableFolders(
    folderIds: string[],
    userId: string,
  ): Promise<Map<string, Types.ObjectId>> {
    const folderMap = new Map<string, Types.ObjectId>();
    if (!folderIds.length) return folderMap;

    for (const folderId of folderIds) {
      if (!Types.ObjectId.isValid(folderId)) {
        throw new BadRequestException('Invalid folder ID');
      }
    }

    const folders = await this.folderModel
      .find({
        _id: { $in: folderIds.map((id) => new Types.ObjectId(id)) },
        createdBy: new Types.ObjectId(userId),
        isDeleted: false,
      })
      .select('_id')
      .lean<Array<{ _id: Types.ObjectId }>>();

    if (folders.length !== folderIds.length) {
      throw new ForbiddenException(
        'You can only upload files to your own folders',
      );
    }

    for (const folder of folders) {
      folderMap.set(folder._id.toString(), folder._id as Types.ObjectId);
    }

    return folderMap;
  }
}
