import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { Cron, CronExpression } from '@nestjs/schedule';

import { SharedLink, SharedLinkDocument } from './schemas/link.schema';
import { LinkAccess, LinkAccessDocument } from './schemas/link-access.schema';
import { FileRecord, FileDocument } from '../files/schemas/file.schema';
import { Folder, FolderDocument } from '../folders/schemas/folder.schema';
import { R2Service } from '../r2/r2.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/schemas/notification.schema';
import { MailService } from '../mail/mail.service';

@Injectable()
export class LinksService {
  private readonly logger = new Logger(LinksService.name);

  constructor(
    @InjectModel(SharedLink.name)
    private readonly linkModel: Model<SharedLinkDocument>,
    @InjectModel(FileRecord.name)
    private readonly fileModel: Model<FileDocument>,
    @InjectModel(Folder.name)
    private readonly folderModel: Model<FolderDocument>,
    @InjectModel(LinkAccess.name)
    private readonly accessModel: Model<LinkAccessDocument>,
    private readonly r2Service: R2Service,
    private readonly notificationsService: NotificationsService,
    private readonly mailService: MailService,
  ) {}

  /* ═══════════════════════════════════════════════
     PUBLIC (unauthenticated) — view link content
  ═══════════════════════════════════════════════ */

  /**
   * Public entry point for a link shortCode.
   * Validates status/expiry/password, tracks view, returns content.
   *
   * For transfer-type links the caller should redirect to
   * GET /transfers/t/:shortCode for full file/folder data.
   * For share-type links this returns the full folder + file tree.
   */
  async publicView(
    shortCode: string,
    password?: string,
    viewer?: { ip: string; userAgent?: string; location?: string | null },
  ) {
    const link = await this.validatePublicLink(shortCode, password);

    await this.linkModel.findByIdAndUpdate(link._id, {
      $inc: { views: 1 },
      $set: { lastViewedAt: new Date() },
    });
    await this.recordAccess(link, 'view', viewer);

    const base = { link: this.formatPublic(link) };

    if (link.type === 'transfer') {
      return { ...base, type: 'transfer' as const };
    }

    // share — load root files + folders
    const [rawFiles, rawFolders] = await Promise.all([
      link.fileIds?.length
        ? this.fileModel
            .find({ _id: { $in: link.fileIds }, isDeleted: false })
            .select('originalName fileName mimeType size key')
            .lean()
        : Promise.resolve([]),
      link.folderIds?.length
        ? this.folderModel
            .find({ _id: { $in: link.folderIds }, isDeleted: false })
            .lean()
        : Promise.resolve([]),
    ]);

    const folders = await Promise.all(
      rawFolders.map(async (f) => {
        const [fileCount, subfolderCount] = await Promise.all([
          this.fileModel.countDocuments({ folderId: f._id, isDeleted: false }),
          this.folderModel.countDocuments({ parentId: f._id, isDeleted: false }),
        ]);
        return {
          id: (f._id as any).toString(),
          name: f.name,
          path: f.path,
          description: f.description ?? '',
          fileCount,
          subfolderCount,
          hasChildren: fileCount > 0 || subfolderCount > 0,
        };
      }),
    );

    return {
      ...base,
      type: 'share' as const,
      files: rawFiles.map((f) => this.formatPublicFile(f)),
      folders,
    };
  }

  /**
   * Browse a specific folder within a share-type link.
   * Validates that the folder is reachable from one of the link's root folderIds.
   */
  async publicFolderContents(
    shortCode: string,
    folderId: string,
    password?: string,
    viewer?: { ip: string; userAgent?: string; location?: string | null },
  ) {
    if (!Types.ObjectId.isValid(folderId))
      throw new BadRequestException('Invalid folder ID');

    const link = await this.validatePublicLink(shortCode, password);
    await this.recordAccess(link, 'view', viewer);

    if (link.type !== 'share') {
      throw new BadRequestException(
        'Folder browsing is only supported for share-type links. ' +
          'Use GET /transfers/t/:shortCode for transfer links.',
      );
    }

    const accessible = await this.isFolderAccessibleViaLink(link, folderId);
    if (!accessible)
      throw new ForbiddenException(
        'Folder is not accessible through this link',
      );

    const folder = await this.folderModel
      .findOne({ _id: folderId, isDeleted: false })
      .lean();
    if (!folder) throw new NotFoundException('Folder not found');

    const fid = new Types.ObjectId(folderId);

    const [rawSubfolders, rawFiles, breadcrumb] = await Promise.all([
      this.folderModel
        .find({ parentId: fid, isDeleted: false })
        .sort({ name: 1 })
        .lean(),
      this.fileModel
        .find({ folderId: fid, isDeleted: false })
        .select('originalName fileName mimeType size key')
        .sort({ createdAt: -1 })
        .lean(),
      this.buildLinkBreadcrumb(link, folder),
    ]);

    const subfolders = await Promise.all(
      rawSubfolders.map(async (sub) => {
        const [fileCount, subfolderCount] = await Promise.all([
          this.fileModel.countDocuments({ folderId: sub._id, isDeleted: false }),
          this.folderModel.countDocuments({ parentId: sub._id, isDeleted: false }),
        ]);
        return {
          id: (sub._id as any).toString(),
          name: sub.name,
          path: sub.path,
          description: sub.description ?? '',
          fileCount,
          subfolderCount,
          hasChildren: fileCount > 0 || subfolderCount > 0,
        };
      }),
    );

    return {
      folder: {
        id: (folder._id as any).toString(),
        name: folder.name,
        path: folder.path,
        description: folder.description ?? '',
        parentId: folder.parentId?.toString() ?? null,
      },
      breadcrumb,
      subfolders,
      files: rawFiles.map((f) => this.formatPublicFile(f)),
      stats: {
        subfolderCount: rawSubfolders.length,
        fileCount: rawFiles.length,
      },
    };
  }

  /**
   * Generate a presigned download URL for a file accessible through a link.
   * Checks permission and validates that the file belongs to the link.
   */
  async publicFileDownload(
    shortCode: string,
    fileId: string,
    password?: string,
    viewer?: { ip: string; userAgent?: string; location?: string | null },
  ) {
    if (!Types.ObjectId.isValid(fileId))
      throw new BadRequestException('Invalid file ID');

    const link = await this.validatePublicLink(shortCode, password);

    if (link.permission !== 'download') {
      throw new ForbiddenException(
        'This link only allows viewing, not downloading',
      );
    }

    const file = await this.resolveFileViaLink(link, fileId);

    await this.linkModel.findByIdAndUpdate(link._id, {
      $inc: { downloads: 1 },
      $set: { lastDownloadedAt: new Date() },
    });
    await this.recordAccess(link, 'download', viewer, {
      fileId,
      fileName: file.originalName,
    });

    const downloadUrl = await this.r2Service.generatePresignedDownloadUrl(
      file.key,
      file.originalName,
    );

    return {
      downloadUrl,
      fileName: file.originalName,
      size: file.size,
      mimeType: file.mimeType,
      expiresIn: 900,
    };
  }

  /* ═══════════════════
     SCHEDULED: AUTO-EXPIRE
  ═══════════════════ */
  @Cron(CronExpression.EVERY_HOUR)
  async expireLinks() {
    await this.syncExpiredLinks();
  }

  private async syncExpiredLinks(now = new Date()) {
    const expiringLinks = await this.linkModel
      .find({
        type: 'share',
        status: 'active',
        expiresAt: { $ne: null, $lte: now },
      })
      .select('_id senderId organizationId shortCode url fileIds folderIds expiresAt')
      .lean<SharedLinkDocument[]>()
      .exec();

    const result = await this.linkModel.updateMany(
      { status: 'active', expiresAt: { $ne: null, $lte: now } },
      { status: 'expired' },
    );
    if (result.modifiedCount > 0) {
      this.logger.log(`Auto-expired ${result.modifiedCount} link(s)`);
      await Promise.allSettled(
        expiringLinks.map((link) =>
          this.notificationsService.create({
            userId: link.senderId.toString(),
            organizationId: link.organizationId?.toString?.() ?? null,
            type: NotificationType.LINK_EXPIRED,
            title: 'Link expired',
            message: 'One of your shared links has expired.',
            targetType: 'link',
            targetId: link._id.toString(),
            metadata: {
              shortCode: link.shortCode,
              url: link.url,
              fileIds: link.fileIds?.map((id) => id.toString()) ?? [],
              folderIds: link.folderIds?.map((id) => id.toString()) ?? [],
              expiresAt: link.expiresAt,
            },
          }),
        ),
      );
    }
    return result;
  }

  /* ═══════════════════
     CREATE STANDALONE SHARE LINK
  ═══════════════════ */
  async createShareLink(
    dto: {
      resourceType: 'file' | 'folder';
      resourceId: string;
      method?: 'link' | 'qr' | 'email';
      permission?: 'view' | 'download';
      privacy?: 'public' | 'private' | 'specific';
      expiresIn?: number;
      password?: string;
      recipients?: string[];
    },
    currentUser: any,
  ) {
    if (!Types.ObjectId.isValid(dto.resourceId)) {
      throw new BadRequestException('Invalid resource ID');
    }

    const userId = new Types.ObjectId(currentUser._id);
    const resourceId = new Types.ObjectId(dto.resourceId);
    const method = dto.method ?? 'link';
    const permission = dto.permission ?? 'download';
    const privacy = dto.privacy ?? (method === 'email' ? 'specific' : 'public');

    let fileIds: Types.ObjectId[] = [];
    let folderIds: Types.ObjectId[] = [];
    let fileCount = 0;
    let totalSize = 0;
    let resourceName = 'Shared item';

    if (dto.resourceType === 'file') {
      const file = await this.fileModel.findOne({
        _id: resourceId,
        uploadedBy: userId,
        isDeleted: false,
      }).lean();
      if (!file) throw new NotFoundException('File not found');
      fileIds = [resourceId];
      fileCount = 1;
      totalSize = file.size ?? 0;
      resourceName = file.originalName ?? file.fileName ?? resourceName;
    } else {
      const folder = await this.folderModel.findOne({
        _id: resourceId,
        createdBy: userId,
        isDeleted: false,
      }).lean();
      if (!folder) throw new NotFoundException('Folder not found');
      folderIds = [resourceId];
      const descendantIds = await this.getDescendantFolderIds(resourceId);
      const allFolderIds = [resourceId, ...descendantIds];
      const stats = await this.fileModel.aggregate([
        { $match: { folderId: { $in: allFolderIds }, isDeleted: false } },
        { $group: { _id: null, count: { $sum: 1 }, size: { $sum: '$size' } } },
      ]);
      fileCount = stats[0]?.count ?? 0;
      totalSize = stats[0]?.size ?? 0;
      resourceName = folder.name ?? resourceName;
    }

    const shortCode = await this.generateUniqueShortCode();
    const url = `${this.frontendUrl()}/l/${shortCode}`;
    const expiresAt = dto.expiresIn
      ? new Date(Date.now() + dto.expiresIn * 86_400_000)
      : null;
    const passwordHash = dto.password
      ? await bcrypt.hash(dto.password, 10)
      : null;
    const recipients = [
      ...new Set(
        (dto.recipients ?? [])
          .map((email) => email.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    if (method === 'email' && recipients.length === 0) {
      throw new BadRequestException(
        'At least one recipient email is required for email links',
      );
    }

    const link = await this.linkModel.create({
      senderId: userId,
      organizationId: currentUser.organizationId
        ? new Types.ObjectId(currentUser.organizationId)
        : null,
      transferId: null,
      type: 'share',
      method,
      fileIds,
      folderIds,
      permission,
      shortCode,
      url,
      qrCodeUrl: this.generateQrCodeUrl(url),
      status: 'active',
      expiresAt,
      hasPassword: Boolean(passwordHash),
      passwordHash,
      privacy,
      fileCount,
      totalSize,
    });

    const formatted = this.format(link.toObject());
    if (method === 'email') {
      void this.mailService.sendTransferEmail(
        recipients,
        shortCode,
        resourceName,
        currentUser.name ?? currentUser.email ?? 'A Jai Export Enterprises user',
        url,
        null,
        expiresAt ?? undefined,
        Boolean(passwordHash),
        {
          userId: String(currentUser._id),
          organizationId: currentUser.organizationId?.toString?.() ?? null,
          linkId: link._id.toString(),
        },
      );
    }
    return {
      ...formatted,
      method,
      recipients,
    };
  }

  /* ═══════════════════
     LIST (own)
  ═══════════════════ */
  async findAll(
    userId: string,
    params: { status?: string; method?: string; page?: number; limit?: number },
  ) {
    await this.syncExpiredLinks();

    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {
      senderId: new Types.ObjectId(userId),
    };
    if (params.status && params.status !== 'all') {
      filter.status = params.status;
    }

    if (params.method && ['link', 'qr', 'email'].includes(params.method)) {
      filter.method = params.method;
    }

    const baseFilter: Record<string, unknown> = { senderId: new Types.ObjectId(userId) };
    if (filter.method) baseFilter.method = filter.method;
    const [links, total, stats] = await Promise.all([
      this.linkModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('transferId', 'title method recipients')
        .lean(),
      this.linkModel.countDocuments(filter),
      this.getLinkStats(baseFilter),
    ]);

    return {
      links: links.map(this.format),
      total,
      page,
      limit,
      ...stats,
      stats,
    };
  }

  /* ═══════════════════
     LIST ALL (admin)
  ═══════════════════ */
  async findAllAdmin(params: {
    status?: string;
    method?: string;
    page?: number;
    limit?: number;
  }) {
    await this.syncExpiredLinks();

    const page = params.page ?? 1;
    const limit = params.limit ?? 50;
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {};
    if (params.status && params.status !== 'all') {
      filter.status = params.status;
    }
    if (params.method && ['link', 'qr', 'email'].includes(params.method)) {
      filter.method = params.method;
    }

    const [links, total, stats] = await Promise.all([
      this.linkModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('transferId', 'title method recipients')
        .populate('senderId', 'name email')
        .lean(),
      this.linkModel.countDocuments(filter),
      this.getLinkStats(filter.method ? { method: filter.method } : {}),
    ]);

    return {
      links: links.map(this.formatAdmin),
      total,
      page,
      limit,
      ...stats,
      stats,
    };
  }

  async getStats(userId: string) {
    await this.syncExpiredLinks();
    return this.getLinkStats({ senderId: new Types.ObjectId(userId) });
  }

  async getStatsAdmin() {
    await this.syncExpiredLinks();
    return this.getLinkStats({});
  }

  /* ═══════════════════
     DISABLE
  ═══════════════════ */
  async disable(id: string, userId: string) {
    const link = await this.findAndVerify(id, userId);
    await this.linkModel.findByIdAndUpdate(link._id, { status: 'disabled' });
  }

  async adminDisable(id: string) {
    const link = await this.findById(id);
    await this.linkModel.findByIdAndUpdate(link._id, { status: 'disabled' });
  }

  /* ═══════════════════
     ENABLE
  ═══════════════════ */
  async enable(id: string, userId: string) {
    const link = await this.findAndVerify(id, userId);
    const status =
      link.expiresAt && link.expiresAt < new Date() ? 'expired' : 'active';
    await this.linkModel.findByIdAndUpdate(link._id, { status });
  }

  async adminEnable(id: string) {
    const link = await this.findById(id);
    const status =
      link.expiresAt && link.expiresAt < new Date() ? 'expired' : 'active';
    await this.linkModel.findByIdAndUpdate(link._id, { status });
  }

  /* ═══════════════════
     RENEW
  ═══════════════════ */
  async renew(id: string, userId: string, days = 7) {
    const link = await this.findAndVerify(id, userId);
    const base =
      link.expiresAt && link.expiresAt > new Date()
        ? link.expiresAt
        : new Date();
    const newExpiry = new Date(base.getTime() + days * 86_400_000);
    await this.linkModel.findByIdAndUpdate(link._id, {
      expiresAt: newExpiry,
      status: 'active',
    });
    return { expiresAt: newExpiry };
  }

  async adminRenew(id: string, days = 7) {
    const link = await this.findById(id);
    const base =
      link.expiresAt && link.expiresAt > new Date()
        ? link.expiresAt
        : new Date();
    const newExpiry = new Date(base.getTime() + days * 86_400_000);
    await this.linkModel.findByIdAndUpdate(link._id, {
      expiresAt: newExpiry,
      status: 'active',
    });
    return { expiresAt: newExpiry };
  }

  async getAccesses(
    id: string,
    currentUser: any,
    params: { page?: number; limit?: number },
  ) {
    const link = await this.findById(id);
    const isOwner = link.senderId.toString() === currentUser._id.toString();
    const isAdmin = currentUser.role === 'admin' || currentUser.role === 'superadmin';
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('You cannot view access details for this link');
    }

    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, params.limit ?? 50);
    const skip = (page - 1) * limit;
    const filter = { linkId: link._id };

    const [accesses, total, summary] = await Promise.all([
      this.accessModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.accessModel.countDocuments(filter),
      this.accessModel.aggregate([
        { $match: filter },
        {
          $group: {
            _id: '$action',
            count: { $sum: 1 },
            uniqueIps: { $addToSet: '$ip' },
          },
        },
      ]),
    ]);

    return {
      accesses: accesses.map((item: any) => ({
        id: item._id?.toString(),
        action: item.action,
        method: item.method,
        ip: item.ip,
        email: item.email,
        userId: item.userId?.toString() ?? null,
        userAgent: item.userAgent,
        browser: item.browser,
        os: item.os,
        device: item.device,
        location: item.location,
        fileId: item.fileId,
        fileName: item.fileName,
        createdAt: item.createdAt,
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      summary: {
        views: summary.find((row) => row._id === 'view')?.count ?? 0,
        downloads: summary.find((row) => row._id === 'download')?.count ?? 0,
        uniqueVisitors: new Set(summary.flatMap((row) => row.uniqueIps ?? [])).size,
      },
    };
  }

  /* ═══════════════════
     DELETE
  ═══════════════════ */
  async delete(id: string, userId: string) {
    await this.findAndVerify(id, userId);
    await this.linkModel.findByIdAndDelete(id);
  }

  async adminDelete(id: string) {
    await this.findById(id);
    await this.linkModel.findByIdAndDelete(id);
  }

  /* ═══════════════════
     PUBLIC LOOKUP (by shortCode, no auth) — metadata only
  ═══════════════════ */
  async findByShortCode(shortCode: string) {
    await this.syncExpiredLinks();

    const link = await this.linkModel
      .findOne({ shortCode })
      .populate('transferId')
      .lean();

    if (!link) throw new NotFoundException('Link not found');
    return this.format(link);
  }

  /* ─────────────────────────────────────────────────────
     PRIVATE: validate a link for unauthenticated access
  ───────────────────────────────────────────────────── */
  private async validatePublicLink(
    shortCode: string,
    password?: string,
  ): Promise<SharedLinkDocument> {
    const link = await this.linkModel
      .findOne({ shortCode })
      .select('+passwordHash');

    if (!link) throw new NotFoundException('Link not found');

    if (link.status === 'disabled') {
      throw new ForbiddenException('This link has been disabled');
    }

    if (link.status === 'expired' || (link.expiresAt && link.expiresAt < new Date())) {
      await this.linkModel.findByIdAndUpdate(link._id, { status: 'expired' });
      throw new ForbiddenException('This link has expired');
    }

    if (link.hasPassword) {
      if (!password) {
        throw new ForbiddenException(
          'This link is password-protected. Provide `password` to continue.',
        );
      }
      const valid = await bcrypt.compare(password, link.passwordHash ?? '');
      if (!valid) throw new ForbiddenException('Incorrect password');
    }

    return link;
  }

  /* ─────────────────────────────────────────────────────
     PRIVATE: check if folderId is reachable via link
     — direct match OR descendant of a linked root folder
  ───────────────────────────────────────────────────── */
  private async isFolderAccessibleViaLink(
    link: SharedLinkDocument,
    folderId: string,
  ): Promise<boolean> {
    const rootIds = link.folderIds ?? [];

    // Direct match
    if (rootIds.some((id) => id.toString() === folderId)) return true;

    // Descendant: the requested folder's path must start with a root folder's full path
    const [requestedFolder, rootFolders] = await Promise.all([
      this.folderModel.findById(folderId).lean(),
      this.folderModel.find({ _id: { $in: rootIds } }).lean(),
    ]);

    if (!requestedFolder) return false;

    for (const root of rootFolders) {
      const rootFullPath = `${root.path}${root.name}/`;
      if ((requestedFolder.path as string).startsWith(rootFullPath)) {
        return true;
      }
    }

    return false;
  }

  /* ─────────────────────────────────────────────────────
     PRIVATE: resolve a file that is accessible via link
     (direct fileIds match OR belongs to an accessible folder)
  ───────────────────────────────────────────────────── */
  private async resolveFileViaLink(
    link: SharedLinkDocument,
    fileId: string,
  ): Promise<FileDocument & { key: string; originalName: string; size: number; mimeType: string }> {
    // Try direct fileIds match first
    const directlyLinked = (link.fileIds ?? []).some(
      (id) => id.toString() === fileId,
    );

    const file = await this.fileModel
      .findOne({ _id: fileId, isDeleted: false })
      .lean() as any;

    if (!file) throw new NotFoundException('File not found');

    if (directlyLinked) return file;

    // Check if the file lives inside one of the linked folders
    if (file.folderId) {
      const accessible = await this.isFolderAccessibleViaLink(
        link,
        file.folderId.toString(),
      );
      if (accessible) return file;
    }

    throw new ForbiddenException('File is not accessible through this link');
  }

  /* ─────────────────────────────────────────────────────
     PRIVATE: build a breadcrumb from link root → current folder
  ───────────────────────────────────────────────────── */
  private async buildLinkBreadcrumb(
    link: SharedLinkDocument,
    currentFolder: any,
  ): Promise<{ id: string; name: string }[]> {
    const rootIds = new Set(
      (link.folderIds ?? []).map((id) => id.toString()),
    );
    const crumbs: { id: string; name: string }[] = [];
    let folder: any = currentFolder;

    while (folder) {
      crumbs.unshift({ id: (folder._id as any).toString(), name: folder.name });
      // Stop once we've added the link's root folder
      if (rootIds.has((folder._id as any).toString())) break;
      if (!folder.parentId) break;
      folder = await this.folderModel
        .findOne({ _id: folder.parentId, isDeleted: false })
        .lean();
    }

    return crumbs;
  }

  /* ─── authenticated helpers ─── */
  private async findAndVerify(
    id: string,
    userId: string,
  ): Promise<SharedLinkDocument> {
    if (!Types.ObjectId.isValid(id))
      throw new BadRequestException('Invalid ID');
    const link = await this.linkModel.findById(id);
    if (!link) throw new NotFoundException('Link not found');
    if (link.senderId.toString() !== userId) throw new ForbiddenException();
    return link;
  }

  private async findById(id: string): Promise<SharedLinkDocument> {
    if (!Types.ObjectId.isValid(id))
      throw new BadRequestException('Invalid ID');
    const link = await this.linkModel.findById(id);
    if (!link) throw new NotFoundException('Link not found');
    return link;
  }

  private async recordAccess(
    link: SharedLinkDocument,
    action: 'view' | 'download',
    viewer?: { ip: string; userAgent?: string; location?: string | null },
    file?: { fileId?: string; fileName?: string },
  ) {
    const userAgent = viewer?.userAgent ?? '';
    await this.accessModel.create({
      linkId: link._id,
      shortCode: link.shortCode,
      method: link.method ?? 'link',
      action,
      userId: null,
      email: null,
      ip: viewer?.ip ?? 'unknown',
      userAgent,
      ...this.parseUserAgent(userAgent),
      location: viewer?.location ?? null,
      fileId: file?.fileId ?? null,
      fileName: file?.fileName ?? null,
    });
  }

  private parseUserAgent(userAgent = '') {
    const ua = userAgent.toLowerCase();
    const browser = ua.includes('edg/')
      ? 'Edge'
      : ua.includes('chrome/')
        ? 'Chrome'
        : ua.includes('safari/') && !ua.includes('chrome/')
          ? 'Safari'
          : ua.includes('firefox/')
            ? 'Firefox'
            : 'Unknown';
    const os = ua.includes('windows')
      ? 'Windows'
      : ua.includes('mac os')
        ? 'macOS'
        : ua.includes('android')
          ? 'Android'
          : ua.includes('iphone') || ua.includes('ipad')
            ? 'iOS'
            : ua.includes('linux')
              ? 'Linux'
              : 'Unknown';
    const device = /mobile|android|iphone|ipad/i.test(userAgent) ? 'Mobile' : 'Desktop';
    return { browser, os, device };
  }

  private async getLinkStats(baseFilter: Record<string, unknown>) {
    const now = new Date();
    const expiredFilter = {
      ...baseFilter,
      $or: [{ status: 'expired' }, { expiresAt: { $ne: null, $lt: now } }],
    };
    const activeFilter = {
      ...baseFilter,
      status: 'active',
      $or: [{ expiresAt: null }, { expiresAt: { $gte: now } }],
    };

    const [totalLinks, activeLinks, expiredLinks, disabledLinks] =
      await Promise.all([
        this.linkModel.countDocuments(baseFilter),
        this.linkModel.countDocuments(activeFilter),
        this.linkModel.countDocuments(expiredFilter),
        this.linkModel.countDocuments({ ...baseFilter, status: 'disabled' }),
      ]);

    return { totalLinks, activeLinks, expiredLinks, disabledLinks };
  }

  /* ─── formatters ─── */

  private formatPublic(l: any) {
    return {
      id: l._id?.toString() ?? l.id,
      shortCode: l.shortCode,
      url: l.url,
      qrCodeUrl: l.qrCodeUrl,
      type: l.type,
      status: l.status,
      permission: l.permission,
      privacy: l.privacy,
      hasPassword: l.hasPassword,
      fileCount: l.fileCount ?? 0,
      totalSize: l.totalSize ?? 0,
      expiresAt: l.expiresAt,
      views: l.views ?? 0,
      downloads: l.downloads ?? 0,
      createdAt: l.createdAt,
    };
  }

  private formatPublicFile(f: any) {
    const name = f.originalName ?? f.fileName ?? '';
    return {
      id: (f._id as any).toString(),
      name,
      size: f.size,
      mimeType: f.mimeType,
      extension: name.split('.').pop()?.toLowerCase() ?? '',
    };
  }

  private format = (l: any) => {
    const transfer =
      l.transferId && typeof l.transferId === 'object' ? l.transferId : null;
    return {
      id: l._id?.toString() ?? l.id,
      transferId: transfer?._id?.toString() ?? l.transferId?.toString?.(),
      transferTitle: transfer?.title,
      type: l.type,
      method: l.method,
      url: l.url,
      qrCodeUrl: l.qrCodeUrl,
      shortCode: l.shortCode,
      status: l.status,
      views: l.views ?? 0,
      downloads: l.downloads ?? 0,
      lastViewedAt: l.lastViewedAt,
      lastDownloadedAt: l.lastDownloadedAt,
      expiresAt: l.expiresAt,
      hasPassword: l.hasPassword,
      privacy: l.privacy,
      fileCount: l.fileCount ?? 0,
      totalSize: l.totalSize ?? 0,
      createdAt: l.createdAt,
      fileIds: l.fileIds?.map((id: any) => id.toString?.() ?? String(id)) ?? [],
      folderIds: l.folderIds?.map((id: any) => id.toString?.() ?? String(id)) ?? [],
    };
  };

  private formatAdmin = (l: any) => {
    const transfer =
      l.transferId && typeof l.transferId === 'object' ? l.transferId : null;
    const sender =
      l.senderId && typeof l.senderId === 'object' ? l.senderId : null;
    return {
      id: l._id?.toString() ?? l.id,
      type: l.type,
      transferId: transfer?._id?.toString() ?? l.transferId?.toString?.(),
      transferTitle: transfer?.title,
      method: l.method,
      user: sender
        ? { id: sender._id?.toString(), name: sender.name, email: sender.email }
        : undefined,
      url: l.url,
      qrCodeUrl: l.qrCodeUrl,
      shortCode: l.shortCode,
      status: l.status,
      views: l.views ?? 0,
      downloads: l.downloads ?? 0,
      lastViewedAt: l.lastViewedAt,
      lastDownloadedAt: l.lastDownloadedAt,
      expiresAt: l.expiresAt,
      hasPassword: l.hasPassword,
      privacy: l.privacy,
      fileCount: l.fileCount ?? 0,
      totalSize: l.totalSize ?? 0,
      createdAt: l.createdAt,
      fileIds: l.fileIds?.map((id: any) => id.toString?.() ?? String(id)) ?? [],
      folderIds: l.folderIds?.map((id: any) => id.toString?.() ?? String(id)) ?? [],
    };
  };

  private frontendUrl() {
    return (
      process.env.FRONTEND_URL ??
      process.env.NEXT_PUBLIC_APP_URL ??
      'http://localhost:3000'
    ).replace(/\/$/, '');
  }

  private async generateUniqueShortCode(): Promise<string> {
    for (let i = 0; i < 8; i += 1) {
      const shortCode = this.generateShortCode();
      const exists = await this.linkModel.exists({ shortCode });
      if (!exists) return shortCode;
    }
    throw new BadRequestException('Could not generate a unique link code');
  }

  private generateShortCode(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = crypto.randomBytes(8);
    let code = '';
    for (const byte of bytes) code += chars[byte % chars.length];
    return code;
  }

  private generateQrCodeUrl(url: string): string {
    return `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(url)}`;
  }

  private async getDescendantFolderIds(folderId: Types.ObjectId): Promise<Types.ObjectId[]> {
    const children = await this.folderModel.find({
      parentId: folderId,
      isDeleted: false,
    }).select('_id').lean();
    const ids = children.map((child) => child._id as Types.ObjectId);
    const nested = await Promise.all(ids.map((id) => this.getDescendantFolderIds(id)));
    return ids.concat(...nested);
  }
}
