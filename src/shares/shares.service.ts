import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  GoneException,
  Logger,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcrypt';

import { Share, ShareDocument } from './schemas/share.schema';
import {
  ShareAccess,
  ShareAccessDocument,
} from './schemas/share-access.schema';
import { FileRecord, FileDocument } from '../files/schemas/file.schema';
import { Folder, FolderDocument } from '../folders/schemas/folder.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { R2Service } from '../r2/r2.service';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/schemas/notification.schema';
import {
  CreateShareDto,
  UpdateShareDto,
  ShareQueryDto,
  AccessQueryDto,
} from './dto/share.dto';
import {
  ShareType,
  SharePermission,
  ResourceType,
  ShareAccessAction,
  Role,
} from '../common/enums';

@Injectable()
export class SharesService {
  private readonly logger = new Logger(SharesService.name);
  private readonly frontendUrl: string;
  private readonly shareUrlBase: string;
  private readonly shareApiUrlBase: string;

  constructor(
    @InjectModel(Share.name) private shareModel: Model<ShareDocument>,
    @InjectModel(ShareAccess.name)
    private shareAccessModel: Model<ShareAccessDocument>,
    @InjectModel(FileRecord.name) private fileModel: Model<FileDocument>,
    @InjectModel(Folder.name) private folderModel: Model<FolderDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private readonly r2Service: R2Service,
    private readonly mailService: MailService,
    private readonly notificationsService: NotificationsService,
    private readonly configService: ConfigService,
  ) {
    this.frontendUrl =
      this.configService.get<string>('app.frontendUrl') ??
      'http://localhost:3000';
    this.shareUrlBase =
      this.configService.get<string>('app.shareUrlBase') ??
      `${this.frontendUrl}/share`;
    this.shareApiUrlBase =
      this.configService.get<string>('app.apiUrl') ??
      'http://localhost:5000/api/v1';
  }

  /* =========================
     CREATE SHARE
  ========================= */
  async create(dto: CreateShareDto, currentUser: any, ip: string) {
    const resource = await this.resolveResource(
      dto.resourceType,
      dto.fileId,
      dto.folderId,
    );
    this.assertCanManage(resource, currentUser, dto.resourceType);

    let passwordHash: string | null = null;
    if (dto.password) {
      passwordHash = await bcrypt.hash(dto.password, 10);
    }

    const shareToken = uuidv4();
    const shareUrl = this.buildShareUrl(shareToken);
    const qrCodeUrl = this.generateQrCodeUrl(shareUrl);

    const share = await this.shareModel.create({
      shareToken,
      shareUrl,
      qrCodeUrl,
      type: dto.type,
      resourceType: dto.resourceType,
      fileId: dto.fileId ? new Types.ObjectId(dto.fileId) : null,
      folderId: dto.folderId ? new Types.ObjectId(dto.folderId) : null,
      createdBy: currentUser._id,
      organizationId: currentUser.organizationId
        ? new Types.ObjectId(currentUser.organizationId)
        : null,
      sharedWithEmails: (dto.sharedWithEmails ?? []).map((e) =>
        e.toLowerCase().trim(),
      ),
      sharedWithUserIds: (dto.sharedWithUserIds ?? []).map(
        (id) => new Types.ObjectId(id),
      ),
      permission: dto.permission ?? SharePermission.DOWNLOAD,
      isPasswordProtected: !!dto.password,
      passwordHash,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      name: dto.name ?? null,
      message: dto.message ?? null,
    });

    const resourceName = this.getResourceName(resource, dto.resourceType);

    // Send email invitations
    if (dto.type === ShareType.EMAIL && dto.sharedWithEmails?.length) {
      await this.mailService.sendShareInvitation(
        dto.sharedWithEmails,
        shareToken,
        resourceName,
        currentUser.name,
        dto.message,
        share.expiresAt ?? undefined,
      );
    }

    // In-app notifications for registered users explicitly added to the share
    const explicitUserIds = new Set(
      (share.sharedWithUserIds ?? []).map((uid: Types.ObjectId) =>
        uid.toString(),
      ),
    );
    const targetType =
      dto.resourceType === ResourceType.FOLDER ? 'folder' : 'file';
    const targetId = dto.fileId ?? dto.folderId ?? null;

    if (explicitUserIds.size) {
      await Promise.allSettled(
        share.sharedWithUserIds.map((uid: Types.ObjectId) =>
          this.notificationsService.create({
            userId: uid.toString(),
            organizationId: currentUser.organizationId?.toString?.() ?? null,
            type:
              dto.resourceType === ResourceType.FOLDER
                ? NotificationType.FOLDER_SHARED
                : NotificationType.FILE_SHARED,
            title:
              dto.resourceType === ResourceType.FOLDER
                ? 'A folder was shared with you'
                : 'A file was shared with you',
            message: `${currentUser.name} shared "${resourceName}" with you.`,
            targetType,
            targetId,
            fileId: targetType === 'file' ? targetId : null,
            metadata: {
              shareToken,
              shareType: dto.type,
              resourceType: dto.resourceType,
              sharedBy: currentUser.name,
            },
          }),
        ),
      );
    }

    // Email shares should also notify registered users whose email matches.
    if (dto.type === ShareType.EMAIL && dto.sharedWithEmails?.length) {
      await this.notifyRegisteredEmailRecipients({
        emails: dto.sharedWithEmails,
        excludeUserIds: new Set([
          currentUser._id?.toString?.() ?? String(currentUser._id),
          ...explicitUserIds,
        ]),
        organizationId: currentUser.organizationId?.toString?.() ?? null,
        resourceType: dto.resourceType,
        resourceId: dto.fileId ?? dto.folderId ?? null,
        resourceName,
        senderName: currentUser.name,
        shareToken,
        shareType: dto.type,
      });
    }

    this.logger.log(
      `Share created | token=${shareToken} | type=${dto.type} | by=${currentUser.email}`,
    );

    return this.populateShare(share);
  }

  private normalizeEmails(emails: string[] = []): string[] {
    return [
      ...new Set(
        emails
          .map((email) => email.toLowerCase().trim())
          .filter(Boolean),
      ),
    ];
  }

  private async notifyRegisteredEmailRecipients(options: {
    emails: string[];
    excludeUserIds: Set<string>;
    organizationId: string | null;
    resourceType: ResourceType;
    resourceId: string | null;
    resourceName: string;
    senderName: string;
    shareToken: string;
    shareType: ShareType;
  }) {
    const emails = this.normalizeEmails(options.emails);
    if (!emails.length) return;

    const users = await this.userModel
      .find({ email: { $in: emails }, isActive: true })
      .select('_id email')
      .lean<{ _id: Types.ObjectId; email: string }[]>()
      .exec();

    const targetType =
      options.resourceType === ResourceType.FOLDER ? 'folder' : 'file';

    await Promise.allSettled(
      users
        .filter((user) => !options.excludeUserIds.has(user._id.toString()))
        .map((user) =>
          this.notificationsService.create({
            userId: user._id.toString(),
            organizationId: options.organizationId,
            type:
              options.resourceType === ResourceType.FOLDER
                ? NotificationType.FOLDER_SHARED
                : NotificationType.FILE_SHARED,
            title:
              options.resourceType === ResourceType.FOLDER
                ? 'A folder was shared with you'
                : 'A file was shared with you',
            message: `${options.senderName} shared "${options.resourceName}" with you.`,
            targetType,
            targetId: options.resourceId,
            fileId: targetType === 'file' ? options.resourceId : null,
            metadata: {
              recipientEmail: user.email,
              shareToken: options.shareToken,
              shareType: options.shareType,
              resourceType: options.resourceType,
              sharedBy: options.senderName,
            },
          }),
        ),
    );
  }

  /* =========================
     LIST MY SHARES
  ========================= */
  async findMyShares(currentUser: any, query: ShareQueryDto) {
    const filter: any = { createdBy: currentUser._id };
    if (query.type) filter.type = query.type;
    if (query.resourceType) filter.resourceType = query.resourceType;
    if (query.isActive !== undefined) filter.isActive = query.isActive;

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 20);
    const skip = (page - 1) * limit;

    const [shares, total] = await Promise.all([
      this.shareModel
        .find(filter)
        .populate('fileId', 'fileName originalName mimeType size')
        .populate('folderId', 'name path')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.shareModel.countDocuments(filter),
    ]);

    return {
      shares,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /* =========================
     GET ONE SHARE
  ========================= */
  async findById(shareId: string, currentUser: any) {
    if (!Types.ObjectId.isValid(shareId)) {
      throw new BadRequestException('Invalid share ID');
    }

    const share = await this.shareModel
      .findById(shareId)
      .populate(
        'fileId',
        'fileName originalName mimeType size description downloadCount',
      )
      .populate('folderId', 'name path description')
      .populate('createdBy', 'name email role')
      .populate('sharedWithUserIds', 'name email role');

    if (!share) throw new NotFoundException('Share not found');

    this.assertOwnerOrAdmin(share, currentUser);
    return share;
  }

  /* =========================
     UPDATE SHARE
  ========================= */
  async update(
    shareId: string,
    dto: UpdateShareDto,
    currentUser: any,
    ip: string,
  ) {
    const share = await this.findById(shareId, currentUser);

    const upd: Record<string, any> = {};
    if (dto.permission !== undefined) upd.permission = dto.permission;
    if (dto.expiresAt !== undefined)
      upd.expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (dto.isActive !== undefined) upd.isActive = dto.isActive;
    if (dto.name !== undefined) upd.name = dto.name;
    if (dto.message !== undefined) upd.message = dto.message;
    if (dto.sharedWithEmails !== undefined) {
      upd.sharedWithEmails = dto.sharedWithEmails.map((e) =>
        e.toLowerCase().trim(),
      );
    }
    if (dto.sharedWithUserIds !== undefined) {
      upd.sharedWithUserIds = dto.sharedWithUserIds.map(
        (id) => new Types.ObjectId(id),
      );
    }
    if (dto.password !== undefined) {
      if (dto.password) {
        upd.isPasswordProtected = true;
        upd.passwordHash = await bcrypt.hash(dto.password, 10);
      } else {
        upd.isPasswordProtected = false;
        upd.passwordHash = null;
      }
    }

    return this.shareModel
      .findByIdAndUpdate(shareId, upd, { new: true })
      .populate('fileId', 'fileName originalName mimeType size')
      .populate('folderId', 'name path')
      .populate('sharedWithUserIds', 'name email');
  }

  /* =========================
     REVOKE SHARE
  ========================= */
  async revoke(shareId: string, currentUser: any, ip: string) {
    const share = await this.findById(shareId, currentUser);
    await this.shareModel.findByIdAndUpdate(shareId, { isActive: false });

    // Notify email recipients
    if (share.sharedWithEmails?.length) {
      const resourceName = await this.getShareResourceName(share);
      await this.mailService.sendShareRevokedNotice(
        share.sharedWithEmails,
        resourceName,
        currentUser.name,
      );
    }

    return { message: 'Share link revoked successfully' };
  }

  /* =========================
     DELETE SHARE
  ========================= */
  async delete(shareId: string, currentUser: any, ip: string) {
    const share = await this.findById(shareId, currentUser);
    await Promise.all([
      this.shareModel.findByIdAndDelete(shareId),
      this.shareAccessModel.deleteMany({
        shareId: new Types.ObjectId(shareId),
      }),
    ]);

    return { message: 'Share deleted permanently' };
  }

  /* =========================
     GET ACCESS LOG
  ========================= */
  async getAccesses(shareId: string, currentUser: any, query: AccessQueryDto) {
    await this.findById(shareId, currentUser);

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(200, query.limit ?? 50);
    const skip = (page - 1) * limit;

    const filter: any = { shareId: new Types.ObjectId(shareId) };
    if (query.action) filter.action = query.action;

    const [accesses, total] = await Promise.all([
      this.shareAccessModel
        .find(filter)
        .populate('userId', 'name email role department')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.shareAccessModel.countDocuments(filter),
    ]);

    // Aggregate stats for this share
    const stats = await this.shareAccessModel.aggregate([
      { $match: { shareId: new Types.ObjectId(shareId) } },
      {
        $group: {
          _id: '$action',
          count: { $sum: 1 },
          uniqueIps: { $addToSet: '$ip' },
        },
      },
    ]);

    const viewStats = stats.find((s) => s._id === ShareAccessAction.VIEW);
    const dlStats = stats.find((s) => s._id === ShareAccessAction.DOWNLOAD);

    return {
      accesses,
      stats: {
        totalViews: viewStats?.count ?? 0,
        uniqueViewers: viewStats?.uniqueIps?.length ?? 0,
        totalDownloads: dlStats?.count ?? 0,
        uniqueDownloaders: dlStats?.uniqueIps?.length ?? 0,
      },
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /* =========================
     PUBLIC: VIEW VIA LINK
  ========================= */
  async accessViaLink(
    token: string,
    password: string | undefined,
    ip: string,
    userAgent: string,
  ): Promise<any> {
    const share = await this.validateLinkShare(token, password);

    await this.shareModel.findByIdAndUpdate(share._id, {
      $inc: { viewCount: 1 },
    });

    await this.shareAccessModel.create({
      shareId: share._id,
      shareToken: token,
      action: ShareAccessAction.VIEW,
      ip,
      userAgent,
      ...this.parseUserAgent(userAgent),
    });
    this.notifyShareAccessed(share, ShareAccessAction.VIEW, ip).catch(
      () => undefined,
    );

    const { resource } = await this.fetchResourceData(share);

    return {
      share: {
        shareToken: share.shareToken,
        shareUrl: this.buildShareUrl(share.shareToken),
        apiUrl: this.buildShareApiUrl(share.shareToken),
        type: share.type,
        resourceType: share.resourceType,
        permission: share.permission,
        expiresAt: share.expiresAt,
        isActive: share.isActive,
        status: this.getShareStatus(share),
        isPasswordProtected: share.isPasswordProtected,
        name: share.name,
        message: share.message,
        viewCount: share.viewCount + 1,
        downloadCount: share.downloadCount,
      },
      resource,
    };
  }

  /* =========================
     PUBLIC: BROWSE FOLDER VIA LINK
  ========================= */
  async accessViaLinkFolder(
    token: string,
    folderId: string,
    password: string | undefined,
    ip: string,
    userAgent: string,
  ) {
    const share = await this.validateLinkShare(token, password);

    if (share.resourceType !== ResourceType.FOLDER || !share.folderId) {
      throw new BadRequestException('This share does not support folder browsing');
    }

    if (!Types.ObjectId.isValid(folderId)) {
      throw new BadRequestException('Invalid folder ID');
    }

    const rootId = share.folderId.toString();
    if (folderId !== rootId) {
      const reachable = await this.isFolderReachable(share.folderId, folderId);
      if (!reachable) {
        throw new ForbiddenException('Folder not accessible via this share');
      }
    }

    const folder = await this.folderModel.findById(folderId).lean();
    if (!folder || folder.isDeleted) {
      throw new NotFoundException('Folder not found');
    }

    const folderId_obj = new Types.ObjectId(folderId);
    const [files, subfolders] = await Promise.all([
      this.fileModel
        .find({ folderId: folderId_obj, isDeleted: false })
        .select('fileName originalName mimeType size')
        .lean(),
      this.folderModel
        .find({ parentId: folderId_obj, isDeleted: false })
        .select('name description')
        .lean(),
    ]);

    const breadcrumb = await this.buildShareBreadcrumb(share.folderId, folderId);

    await this.shareAccessModel.create({
      shareId: share._id,
      shareToken: token,
      action: ShareAccessAction.VIEW,
      ip,
      userAgent,
      ...this.parseUserAgent(userAgent),
    });

    return {
      folder: {
        id: (folder as any)._id.toString(),
        name: folder.name,
        description: folder.description ?? null,
        parentId: folder.parentId?.toString() ?? null,
      },
      breadcrumb,
      subfolders: subfolders.map((f) => ({
        id: (f as any)._id.toString(),
        name: f.name,
        description: f.description ?? null,
      })),
      files: files.map((f) => ({
        id: (f as any)._id.toString(),
        name: f.originalName,
        size: f.size,
        mimeType: f.mimeType,
        extension: f.originalName.split('.').pop()?.toLowerCase() ?? '',
      })),
    };
  }

  /* =========================
     PUBLIC: DOWNLOAD VIA LINK (all files)
  ========================= */
  async downloadViaLink(
    token: string,
    password: string | undefined,
    ip: string,
    userAgent: string,
  ) {
    const share = await this.validateLinkShare(token, password);

    if (share.permission !== SharePermission.DOWNLOAD) {
      throw new ForbiddenException(
        'This share link only allows viewing, not downloading',
      );
    }

    await this.shareModel.findByIdAndUpdate(share._id, {
      $inc: { downloadCount: 1 },
    });

    await this.shareAccessModel.create({
      shareId: share._id,
      shareToken: token,
      action: ShareAccessAction.DOWNLOAD,
      ip,
      userAgent,
      ...this.parseUserAgent(userAgent),
    });
    this.notifyShareAccessed(share, ShareAccessAction.DOWNLOAD, ip).catch(
      () => undefined,
    );

    if (share.resourceType === ResourceType.FILE && share.fileId) {
      const file = await this.fileModel.findById(share.fileId);
      if (!file || file.isDeleted)
        throw new NotFoundException('File not found or deleted');

      const downloadUrl = await this.r2Service.generatePresignedDownloadUrl(
        file.key,
        file.originalName,
      );

      return {
        resourceType: 'file',
        downloadUrl,
        fileName: file.originalName,
        size: file.size,
        mimeType: file.mimeType,
        expiresIn: 900,
      };
    }

    if (share.resourceType === ResourceType.FOLDER && share.folderId) {
      // Recursively collect files from all descendant folders
      const descendantIds = await this.getAllDescendantFolderIds(share.folderId);
      const allFolderIds = [share.folderId, ...descendantIds];

      const files = await this.fileModel
        .find({ folderId: { $in: allFolderIds }, isDeleted: false })
        .select('fileName originalName mimeType size key');

      const downloadUrls = await Promise.all(
        files.map(async (f) => ({
          fileId: f._id,
          fileName: f.originalName,
          size: f.size,
          mimeType: f.mimeType,
          downloadUrl: await this.r2Service.generatePresignedDownloadUrl(
            f.key,
            f.originalName,
          ),
        })),
      );

      return {
        resourceType: 'folder',
        files: downloadUrls,
        expiresIn: 900,
      };
    }

    throw new NotFoundException('Resource not found');
  }

  /* =========================
     PUBLIC: DOWNLOAD SINGLE FILE VIA LINK
  ========================= */
  async downloadViaLinkFile(
    token: string,
    fileId: string,
    password: string | undefined,
    ip: string,
    userAgent: string,
  ) {
    const share = await this.validateLinkShare(token, password);

    if (share.permission !== SharePermission.DOWNLOAD) {
      throw new ForbiddenException(
        'This share link only allows viewing, not downloading',
      );
    }

    if (!Types.ObjectId.isValid(fileId)) {
      throw new BadRequestException('Invalid file ID');
    }

    const file = await this.fileModel.findById(fileId);
    if (!file || file.isDeleted) {
      throw new NotFoundException('File not found or deleted');
    }

    if (share.resourceType === ResourceType.FILE) {
      if (!share.fileId || share.fileId.toString() !== fileId) {
        throw new ForbiddenException('File not accessible via this share');
      }
    } else if (share.resourceType === ResourceType.FOLDER) {
      if (!share.folderId) throw new ForbiddenException('File not accessible');
      const fileFolderId = file.folderId?.toString();
      if (!fileFolderId) throw new ForbiddenException('File not in a folder');
      const rootId = share.folderId.toString();
      if (fileFolderId !== rootId) {
        const reachable = await this.isFolderReachable(share.folderId, fileFolderId);
        if (!reachable) {
          throw new ForbiddenException('File not accessible via this share');
        }
      }
    }

    const downloadUrl = await this.r2Service.generatePresignedDownloadUrl(
      file.key,
      file.originalName,
    );

    await Promise.all([
      this.shareModel.findByIdAndUpdate(share._id, { $inc: { downloadCount: 1 } }),
      this.shareAccessModel.create({
        shareId: share._id,
        shareToken: token,
        action: ShareAccessAction.DOWNLOAD,
        ip,
        userAgent,
        ...this.parseUserAgent(userAgent),
      }),
    ]);
    this.notifyShareAccessed(share, ShareAccessAction.DOWNLOAD, ip, file.originalName).catch(
      () => undefined,
    );

    return {
      downloadUrl,
      fileName: file.originalName,
      size: file.size,
      mimeType: file.mimeType,
      expiresIn: 900,
    };
  }

  /* =========================
     CHECK FILE ACCESS (used by FilesService)
  ========================= */
  async hasShareAccessToFile(
    fileId: string,
    userId: string,
    userEmail?: string,
  ): Promise<boolean> {
    const now = new Date();
    const conditions: any[] = [
      { sharedWithUserIds: new Types.ObjectId(userId) },
      { type: ShareType.LINK },
    ];
    if (userEmail) {
      conditions.push({ sharedWithEmails: userEmail.toLowerCase() });
    }

    const share = await this.shareModel.findOne({
      fileId: new Types.ObjectId(fileId),
      isActive: true,
      $and: [
        { $or: conditions },
        { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
      ],
    });

    return !!share;
  }

  async hasShareAccessToFolder(
    folderId: string,
    userId: string,
    userEmail?: string,
  ): Promise<boolean> {
    const now = new Date();
    const conditions: any[] = [
      { sharedWithUserIds: new Types.ObjectId(userId) },
      { type: ShareType.LINK },
    ];
    if (userEmail) {
      conditions.push({ sharedWithEmails: userEmail.toLowerCase() });
    }

    const share = await this.shareModel.findOne({
      folderId: new Types.ObjectId(folderId),
      isActive: true,
      $and: [
        { $or: conditions },
        { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
      ],
    });

    return !!share;
  }

  /* =========================
     ADMIN: ALL SHARES
  ========================= */
  async getAllShares(currentUser: any, query: ShareQueryDto) {
    const filter: any = {};

    // Admins see all; superadmins see all too — both have the role check at route level
    if (query.type) filter.type = query.type;
    if (query.resourceType) filter.resourceType = query.resourceType;
    if (query.isActive !== undefined) filter.isActive = query.isActive;

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 20);
    const skip = (page - 1) * limit;

    const [shares, total] = await Promise.all([
      this.shareModel
        .find(filter)
        .populate('fileId', 'fileName originalName mimeType size')
        .populate('folderId', 'name path')
        .populate('createdBy', 'name email role department')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.shareModel.countDocuments(filter),
    ]);

    return {
      shares,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /* =========================
     ADMIN: ALL ACCESS LOGS
  ========================= */
  async getAllAccesses(query: AccessQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(200, query.limit ?? 50);
    const skip = (page - 1) * limit;

    const filter: any = {};
    if (query.action) filter.action = query.action;

    const [accesses, total] = await Promise.all([
      this.shareAccessModel
        .find(filter)
        .populate('userId', 'name email role')
        .populate('shareId', 'shareToken type resourceType name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.shareAccessModel.countDocuments(filter),
    ]);

    return {
      accesses,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /* =========================
     ADMIN: ANALYTICS
  ========================= */
  async getShareAnalytics() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalShares,
      activeShares,
      expiredShares,
      byType,
      byPermission,
      byResourceType,
      totalCounts,
      topSharedFiles,
      recentAccesses,
      accessTrend,
      deviceBreakdown,
      browserBreakdown,
    ] = await Promise.all([
      this.shareModel.countDocuments(),
      this.shareModel.countDocuments({ isActive: true }),
      this.shareModel.countDocuments({ expiresAt: { $lt: new Date() } }),

      this.shareModel.aggregate([
        { $group: { _id: '$type', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      this.shareModel.aggregate([
        { $group: { _id: '$permission', count: { $sum: 1 } } },
      ]),
      this.shareModel.aggregate([
        { $group: { _id: '$resourceType', count: { $sum: 1 } } },
      ]),
      this.shareModel.aggregate([
        {
          $group: {
            _id: null,
            totalViews: { $sum: '$viewCount' },
            totalDownloads: { $sum: '$downloadCount' },
          },
        },
      ]),

      // Top 10 most-viewed shared files
      this.shareModel.aggregate([
        { $match: { resourceType: ResourceType.FILE, isActive: true } },
        { $sort: { viewCount: -1 } },
        { $limit: 10 },
        {
          $lookup: {
            from: 'files',
            localField: 'fileId',
            foreignField: '_id',
            as: 'file',
          },
        },
        { $unwind: { path: '$file', preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: 'users',
            localField: 'createdBy',
            foreignField: '_id',
            as: 'sharedBy',
          },
        },
        { $unwind: { path: '$sharedBy', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            shareToken: 1,
            type: 1,
            permission: 1,
            viewCount: 1,
            downloadCount: 1,
            expiresAt: 1,
            isActive: 1,
            'file.fileName': 1,
            'file.originalName': 1,
            'file.mimeType': 1,
            'file.size': 1,
            'sharedBy.name': 1,
            'sharedBy.email': 1,
          },
        },
      ]),

      // Recent 20 access events
      this.shareAccessModel
        .find()
        .populate('userId', 'name email role')
        .populate('shareId', 'shareToken type name')
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),

      // Daily access trend (last 7 days)
      this.shareAccessModel.aggregate([
        { $match: { createdAt: { $gte: sevenDaysAgo } } },
        {
          $group: {
            _id: {
              date: {
                $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
              },
              action: '$action',
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.date': 1 } },
      ]),

      // Device breakdown
      this.shareAccessModel.aggregate([
        { $group: { _id: '$device', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),

      // Browser breakdown
      this.shareAccessModel.aggregate([
        { $group: { _id: '$browser', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);

    const counts = totalCounts[0] ?? { totalViews: 0, totalDownloads: 0 };

    return {
      overview: {
        totalShares,
        activeShares,
        revokedShares: totalShares - activeShares,
        expiredShares,
        totalViews: counts.totalViews,
        totalDownloads: counts.totalDownloads,
      },
      breakdown: {
        byType,
        byPermission,
        byResourceType,
      },
      topSharedFiles,
      recentAccesses,
      accessTrend,
      deviceBreakdown,
      browserBreakdown,
    };
  }

  /* =========================
     SCHEDULED: AUTO-EXPIRE
  ========================= */
  @Cron(CronExpression.EVERY_HOUR)
  async expireShares() {
    const now = new Date();
    const expiringShares = await this.shareModel
      .find({ isActive: true, expiresAt: { $lte: now } })
      .select('_id shareToken resourceType fileId folderId createdBy organizationId expiresAt')
      .lean<ShareDocument[]>()
      .exec();

    const result = await this.shareModel.updateMany(
      { _id: { $in: expiringShares.map((share) => share._id) } },
      { isActive: false },
    );
    if (result.modifiedCount > 0) {
      this.logger.log(`Auto-expired ${result.modifiedCount} share(s)`);
      await Promise.allSettled(
        expiringShares.map((share) =>
          this.notificationsService.create({
            userId: share.createdBy.toString(),
            organizationId: share.organizationId?.toString?.() ?? null,
            type: NotificationType.LINK_EXPIRED,
            title: 'Share link expired',
            message: 'One of your share links has expired.',
            targetType: 'link',
            targetId: share._id.toString(),
            metadata: {
              shareToken: share.shareToken,
              resourceType: share.resourceType,
              fileId: share.fileId?.toString?.() ?? null,
              folderId: share.folderId?.toString?.() ?? null,
              expiresAt: share.expiresAt,
            },
          }),
        ),
      );
    }
  }

  /* =========================
     PRIVATE HELPERS
  ========================= */
  private async notifyShareAccessed(
    share: ShareDocument,
    action: ShareAccessAction,
    ip: string,
    fileName?: string,
  ) {
    const targetType =
      share.resourceType === ResourceType.FOLDER ? 'folder' : 'file';
    const targetId = share.fileId ?? share.folderId;
    const actionLabel =
      action === ShareAccessAction.DOWNLOAD ? 'downloaded' : 'viewed';

    await this.notificationsService.create({
      userId: share.createdBy.toString(),
      organizationId: share.organizationId?.toString?.() ?? null,
      type: NotificationType.SHARE_ACCESSED,
      title:
        action === ShareAccessAction.DOWNLOAD
          ? 'Share downloaded'
          : 'Share viewed',
      message: fileName
        ? `"${fileName}" was ${actionLabel} through your share link.`
        : `Your shared ${targetType} was ${actionLabel}.`,
      targetType,
      targetId: targetId?.toString?.() ?? null,
      fileId: targetType === 'file' ? targetId?.toString?.() ?? null : null,
      metadata: {
        shareToken: share.shareToken,
        action,
        ip,
        resourceType: share.resourceType,
        fileName,
      },
    });
  }

  private async validateLinkShare(
    token: string,
    password?: string,
  ): Promise<ShareDocument> {
    const share = await this.shareModel
      .findOne({ shareToken: token })
      .select('+passwordHash');

    if (!share) throw new NotFoundException('Share link not found or invalid');
    if (!share.isActive)
      throw new GoneException('This share link has been revoked');
    if (share.expiresAt && share.expiresAt < new Date()) {
      throw new GoneException('This share link has expired');
    }

    if (share.isPasswordProtected) {
      if (!password) {
        throw new ForbiddenException(
          'This share is password-protected. Provide the password to continue.',
        );
      }
      const valid = await bcrypt.compare(password, share.passwordHash!);
      if (!valid) throw new ForbiddenException('Incorrect password');
    }

    return share;
  }

  private async resolveResource(
    resourceType: ResourceType,
    fileId?: string,
    folderId?: string,
  ) {
    if (resourceType === ResourceType.FILE) {
      if (!fileId || !Types.ObjectId.isValid(fileId)) {
        throw new BadRequestException(
          'Valid fileId is required for file shares',
        );
      }
      const file = await this.fileModel.findOne({
        _id: fileId,
        isDeleted: false,
      });
      if (!file) throw new NotFoundException('File not found');
      return file;
    }

    if (resourceType === ResourceType.FOLDER) {
      if (!folderId || !Types.ObjectId.isValid(folderId)) {
        throw new BadRequestException(
          'Valid folderId is required for folder shares',
        );
      }
      const folder = await this.folderModel.findOne({
        _id: folderId,
        isDeleted: false,
      });
      if (!folder) throw new NotFoundException('Folder not found');
      return folder;
    }

    throw new BadRequestException('Invalid resourceType');
  }

  private assertCanManage(
    resource: any,
    currentUser: any,
    resourceType: ResourceType,
  ) {
    const isAdmin =
      currentUser.role === Role.ADMIN || currentUser.role === Role.SUPERADMIN;
    if (isAdmin) return;

    const ownerId =
      resourceType === ResourceType.FILE
        ? resource.uploadedBy?.toString()
        : resource.createdBy?.toString();

    if (ownerId !== currentUser._id.toString()) {
      throw new ForbiddenException('You can only share resources you own');
    }
  }

  private assertOwnerOrAdmin(share: ShareDocument, currentUser: any) {
    const isOwner = share.createdBy.toString() === currentUser._id.toString();
    const isAdmin =
      currentUser.role === Role.ADMIN || currentUser.role === Role.SUPERADMIN;
    if (!isOwner && !isAdmin) throw new ForbiddenException('Access denied');
  }

  private async fetchResourceData(share: ShareDocument) {
    if (share.resourceType === ResourceType.FILE && share.fileId) {
      const file = await this.fileModel
        .findById(share.fileId)
        .select('fileName originalName mimeType size description')
        .lean();
      return { resource: file };
    }

    if (share.resourceType === ResourceType.FOLDER && share.folderId) {
      const folder = await this.folderModel
        .findById(share.folderId)
        .select('name path description')
        .lean();

      const [files, subfolders] = await Promise.all([
        this.fileModel
          .find({ folderId: share.folderId, isDeleted: false })
          .select('fileName originalName mimeType size')
          .lean(),
        this.folderModel
          .find({ parentId: share.folderId, isDeleted: false })
          .select('name description')
          .lean(),
      ]);

      return { resource: { ...folder, files, subfolders } };
    }

    return { resource: null };
  }

  private async getAllDescendantFolderIds(
    rootId: Types.ObjectId,
  ): Promise<Types.ObjectId[]> {
    const result: Types.ObjectId[] = [];
    const queue: Types.ObjectId[] = [rootId];

    while (queue.length) {
      const parentId = queue.shift()!;
      const children = await this.folderModel
        .find({ parentId, isDeleted: false })
        .select('_id')
        .lean();
      for (const child of children) {
        const childId = (child as any)._id as Types.ObjectId;
        result.push(childId);
        queue.push(childId);
      }
    }

    return result;
  }

  private async isFolderReachable(
    rootFolderId: Types.ObjectId,
    targetFolderId: string,
  ): Promise<boolean> {
    if (!Types.ObjectId.isValid(targetFolderId)) return false;
    const rootId = rootFolderId.toString();
    let currentId: string | null = targetFolderId;
    const visited = new Set<string>();

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      if (currentId === rootId) return true;
      const folder: { parentId?: Types.ObjectId | null } | null =
        await this.folderModel.findById(currentId).select('parentId').lean();
      if (!folder) return false;
      currentId = folder.parentId?.toString() ?? null;
    }

    return false;
  }

  private async buildShareBreadcrumb(
    rootFolderId: Types.ObjectId,
    currentFolderId: string,
  ): Promise<{ id: string; name: string }[]> {
    const crumbs: { id: string; name: string }[] = [];
    const rootId = rootFolderId.toString();
    let currentId: string | null = currentFolderId;
    const visited = new Set<string>();

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const folder: { name: string; parentId?: Types.ObjectId | null } | null =
        await this.folderModel.findById(currentId).select('name parentId').lean();
      if (!folder) break;
      crumbs.unshift({ id: currentId, name: folder.name });
      if (currentId === rootId) break;
      currentId = folder.parentId?.toString() ?? null;
    }

    return crumbs;
  }

  private async getShareResourceName(share: ShareDocument): Promise<string> {
    if (share.resourceType === ResourceType.FILE && share.fileId) {
      const file = await this.fileModel
        .findById(share.fileId)
        .select('originalName fileName');
      return file?.originalName ?? file?.fileName ?? 'File';
    }
    if (share.resourceType === ResourceType.FOLDER && share.folderId) {
      const folder = await this.folderModel
        .findById(share.folderId)
        .select('name');
      return folder?.name ?? 'Folder';
    }
    return 'Item';
  }

  private getResourceName(resource: any, resourceType: ResourceType): string {
    if (resourceType === ResourceType.FILE)
      return resource.originalName ?? resource.fileName ?? 'File';
    return resource.name ?? 'Folder';
  }

  private generateQrCodeUrl(url: string): string {
    return `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(url)}`;
  }

  private buildShareUrl(token: string): string {
    return `${this.shareUrlBase}/${token}`;
  }

  private buildShareApiUrl(token: string): string {
    return `${this.shareApiUrlBase}/shares/link/${token}`;
  }

  private getShareStatus(share: ShareDocument): 'active' | 'expired' | 'revoked' {
    if (!share.isActive) return 'revoked';
    if (share.expiresAt && share.expiresAt < new Date()) return 'expired';
    return 'active';
  }

  private async populateShare(share: ShareDocument) {
    return share.populate([
      { path: 'fileId', select: 'fileName originalName mimeType size' },
      { path: 'folderId', select: 'name path' },
      { path: 'createdBy', select: 'name email' },
    ]);
  }

  private parseUserAgent(ua: string = '') {
    return {
      browser: this.detectBrowser(ua),
      os: this.detectOs(ua),
      device: this.detectDevice(ua),
    };
  }

  private detectBrowser(ua: string): string {
    if (/Edg\//i.test(ua)) return 'Edge';
    if (/Chrome\/\d/i.test(ua) && !/Chromium/i.test(ua)) return 'Chrome';
    if (/Firefox\/\d/i.test(ua)) return 'Firefox';
    if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) return 'Safari';
    if (/MSIE|Trident/i.test(ua)) return 'Internet Explorer';
    if (/OPR\//i.test(ua)) return 'Opera';
    return 'Unknown';
  }

  private detectOs(ua: string): string {
    if (/Windows/i.test(ua)) return 'Windows';
    if (/Android/i.test(ua)) return 'Android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
    if (/Mac OS X/i.test(ua)) return 'macOS';
    if (/Linux/i.test(ua)) return 'Linux';
    return 'Unknown';
  }

  private detectDevice(ua: string): string {
    if (/Mobile|Android.*Mobile|iPhone/i.test(ua)) return 'mobile';
    if (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua)) return 'tablet';
    return 'desktop';
  }
}
