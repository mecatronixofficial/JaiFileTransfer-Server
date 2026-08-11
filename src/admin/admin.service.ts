import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as os from 'os';

import { User } from '../users/schemas/user.schema';
import { FileRecord } from '../files/schemas/file.schema';
import { Share } from '../shares/schemas/share.schema';
import { ShareAccess } from '../shares/schemas/share-access.schema';
import { Transfer, TransferDocument } from '../transfers/schemas/transfer.schema';
import { SharedLink, SharedLinkDocument } from '../links/schemas/link.schema';
import { UploadSession, UploadSessionDocument } from '../upload/schemas/upload-session.schema';
import { Role, ResourceType } from '../common/enums';
import {
  AdminUsersDto,
  AdminFilesDto,
  AdminTransfersDto,
  AdminLinksDto,
  AdminSessionsDto,
} from './dto/admin.dto';
import {
  RawStorageCategoryStat,
  buildStorageCategoryStats,
  storageCategoryExpression,
} from '../files/storage-category.util';

type FailedUploadSession = {
  _id?: Types.ObjectId;
  fileName?: string;
  createdAt?: Date;
  updatedAt?: Date;
};

type CollectionStat = {
  ns?: string;
  count?: number;
  size?: number;
  storageSize?: number;
  totalIndexSize?: number;
  nindexes?: number;
};

type CountById = {
  _id: string | null;
  count: number;
};

type UserSummary = {
  id?: string;
  name?: string;
  email?: string;
  role?: string;
  department?: string;
};

type AuditLogEvent = {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actor: UserSummary | null;
  message: string;
  metadata: Record<string, any>;
  createdAt: Date;
};

@Injectable()
export class AdminService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(FileRecord.name) private readonly fileModel: Model<FileRecord>,
    @InjectModel(Share.name) private readonly shareModel: Model<Share>,
    @InjectModel(ShareAccess.name) private readonly shareAccessModel: Model<ShareAccess>,
    @InjectModel(Transfer.name) private readonly transferModel: Model<TransferDocument>,
    @InjectModel(SharedLink.name) private readonly linkModel: Model<SharedLinkDocument>,
    @InjectModel(UploadSession.name) private readonly sessionModel: Model<UploadSessionDocument>,
  ) {}

  /* =========================
     SYSTEM HEALTH
  ========================= */
  async getSystemHealth(currentUser: any) {
    const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
    const lastChecked = new Date().toISOString();
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const memoryUsage = totalMemory > 0
      ? +(((totalMemory - freeMemory) / totalMemory) * 100).toFixed(1)
      : 0;
    const cpuCount = Math.max(os.cpus().length, 1);
    const cpuUsage = +Math.min(100, (os.loadavg()[0] / cpuCount) * 100).toFixed(1);
    const dbReadyState = this.userModel.db.readyState;
    const dbConnected = dbReadyState === 1;

    const [
      activeUploadSessions,
      failedUploadSessions,
      recentFailedSessions,
      recentUploads,
    ] = await Promise.all([
      this.sessionModel.countDocuments({ status: 'uploading' }),
      this.sessionModel.countDocuments({ status: 'failed' }),
      this.sessionModel
        .find({ status: 'failed' })
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(5)
        .select('fileName status updatedAt createdAt')
        .lean<FailedUploadSession[]>(),
      this.sessionModel.countDocuments({
        createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
      }),
    ]);

    const recentErrors = recentFailedSessions.map((session) => ({
      id: session._id?.toString(),
      code: 'UPLOAD_FAILED',
      message: `Upload failed: ${session.fileName ?? 'unknown file'}`,
      count: 1,
      lastAt: (session.updatedAt ?? session.createdAt ?? new Date()).toISOString(),
      service: 'Upload Service',
      path: '/api/v1/upload',
    }));

    const status =
      !dbConnected || cpuUsage >= 90 || memoryUsage >= 90
        ? 'down'
        : cpuUsage >= 70 || memoryUsage >= 70 || failedUploadSessions > 0
          ? 'degraded'
          : 'healthy';

    return {
      status,
      uptime: 100,
      cpuUsage,
      memoryUsage,
      diskUsage: 0,
      dbConnections: dbConnected ? 1 : 0,
      dbMaxConnections: 100,
      activeRequests: activeUploadSessions,
      errorRate: recentUploads > 0
        ? +Math.min(100, (failedUploadSessions / recentUploads) * 100).toFixed(2)
        : 0,
      requestsPerMinute: 0,
      avgResponseMs: 0,
      p95ResponseMs: 0,
      environment: process.env.NODE_ENV ?? 'development',
      region: process.env.APP_REGION ?? 'local',
      version: process.env.npm_package_version ?? '1.0.0',
      nodeVersion: process.version,
      hostname: os.hostname(),
      startedAt,
      lastChecked,
      services: [
        {
          id: 'api',
          name: 'API Server',
          status: 'operational',
          latencyMs: 0,
          uptime: 100,
          checkedAt: lastChecked,
          message: 'NestJS process is responding',
        },
        {
          id: 'database',
          name: 'MongoDB',
          status: dbConnected ? 'operational' : 'down',
          latencyMs: 0,
          uptime: dbConnected ? 100 : 0,
          checkedAt: lastChecked,
          message: dbConnected ? 'Database connection is ready' : `Database readyState=${dbReadyState}`,
        },
        {
          id: 'upload',
          name: 'Upload Service',
          status: failedUploadSessions > 0 ? 'degraded' : 'operational',
          latencyMs: 0,
          uptime: failedUploadSessions > 0 ? 99 : 100,
          checkedAt: lastChecked,
          message: `${activeUploadSessions} active upload sessions`,
        },
        {
          id: 'storage',
          name: 'File Storage',
          status: 'operational',
          latencyMs: 0,
          uptime: 100,
          checkedAt: lastChecked,
          message: 'Storage provider configured through upload pipeline',
        },
      ],
      recentErrors,
      role: currentUser.role,
    };
  }

  async getDatabaseStats() {
    const connection = this.userModel.db;
    const db = connection.db;
    const lastChecked = new Date().toISOString();

    if (!db) {
      return {
        status: 'down',
        name: connection.name,
        host: connection.host,
        readyState: connection.readyState,
        totalSize: 0,
        dataSize: 0,
        indexSize: 0,
        storageSize: 0,
        collections: 0,
        objects: 0,
        avgObjectSize: 0,
        connections: connection.readyState === 1 ? 1 : 0,
        maxConnections: 100,
        activeQueries: 0,
        slowQueries: 0,
        cacheHitRatio: 0,
        avgQueryMs: 0,
        lastChecked,
        tables: [],
        slowQueryLog: [],
        backups: [],
      };
    }

    const [stats, collections] = await Promise.all([
      db.stats().catch(() => null),
      db.listCollections({}, { nameOnly: true }).toArray(),
    ]);

    const tables = await Promise.all(
      collections.map(async (collection) => {
        const name = collection.name;
        const collStats = await db
          .command({ collStats: name })
          .catch(() => null as CollectionStat | null);
        const indexes = await db
          .collection(name)
          .indexes()
          .catch(() => []);

        return {
          name,
          rows: collStats?.count ?? 0,
          size: collStats?.size ?? 0,
          storageSize: collStats?.storageSize ?? 0,
          indexSize: collStats?.totalIndexSize ?? 0,
          indexes: collStats?.nindexes ?? indexes.length,
          lastWrite: null,
        };
      }),
    );

    const dataSize = stats?.dataSize ?? tables.reduce((sum, table) => sum + table.size, 0);
    const indexSize = stats?.indexSize ?? tables.reduce((sum, table) => sum + table.indexSize, 0);
    const storageSize = stats?.storageSize ?? tables.reduce((sum, table) => sum + table.storageSize, 0);
    const totalSize = stats?.totalSize ?? dataSize + indexSize;

    return {
      status: connection.readyState === 1 ? 'healthy' : 'down',
      name: connection.name,
      host: connection.host,
      port: connection.port,
      readyState: connection.readyState,
      totalSize,
      dataSize,
      indexSize,
      storageSize,
      collections: stats?.collections ?? tables.length,
      objects: stats?.objects ?? tables.reduce((sum, table) => sum + table.rows, 0),
      avgObjectSize: stats?.avgObjSize ?? 0,
      connections: connection.readyState === 1 ? 1 : 0,
      maxConnections: 100,
      activeQueries: 0,
      slowQueries: 0,
      cacheHitRatio: 0,
      avgQueryMs: 0,
      lastChecked,
      tables: tables.sort((a, b) => b.size - a.size),
      slowQueryLog: [],
      backups: [],
    };
  }

  /* =========================
     DASHBOARD OVERVIEW
  ========================= */
  async getDashboardStats(currentUser: any) {
    const last7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const isSuperAdmin = currentUser.role === Role.SUPERADMIN;

    let managedUserIds: Types.ObjectId[] = [];
    if (!isSuperAdmin) {
      managedUserIds = await this.getManagedUserIds(currentUser._id);
    }

    const userFilter = isSuperAdmin ? {} : { createdBy: currentUser._id };
    const fileFilter = isSuperAdmin ? {} : { uploadedBy: { $in: managedUserIds } };
    const shareFilter = isSuperAdmin ? {} : { createdBy: { $in: managedUserIds } };
    const transferFilter = isSuperAdmin ? {} : { senderId: { $in: managedUserIds } };
    const linkFilter = isSuperAdmin ? {} : { senderId: { $in: managedUserIds } };
    const sessionFilter = isSuperAdmin ? {} : { userId: { $in: managedUserIds } };

    const [
      totalUsers,
      activeUsers,
      totalFiles,
      deletedFiles,
      usersByRole,
      totalShares,
      activeShares,
      totalStorage,
      uploadsLast7d,
      sharesLast7d,
      totalTransfers,
      activeTransfers,
      transfersLast7d,
      totalLinks,
      activeLinks,
      linksLast7d,
      activeUploadSessions,
      transfersByStatus,
      linksByStatus,
      linksByType,
      transferLinks,
      shareLinks,
      auditLogs,
      linkEngagement,
      transfersToday,
      downloadsToday,
      newUsersToday,
      uploadsToday,
    ] = await Promise.all([
      this.userModel.countDocuments(userFilter),
      this.userModel.countDocuments({ ...userFilter, isActive: true }),
      this.fileModel.countDocuments({ ...fileFilter, isDeleted: false }),
      this.fileModel.countDocuments({ ...fileFilter, isDeleted: true }),
      isSuperAdmin
        ? this.userModel.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }])
        : ([] as { _id: string; count: number }[]),
      this.shareModel.countDocuments(shareFilter),
      this.shareModel.countDocuments({ ...shareFilter, isActive: true }),
      this.fileModel.aggregate([
        { $match: { ...fileFilter, isDeleted: false } },
        { $group: { _id: null, totalBytes: { $sum: '$size' } } },
      ]),
      this.fileModel.countDocuments({
        ...fileFilter,
        isDeleted: false,
        createdAt: { $gte: last7d },
      }),
      this.shareModel.countDocuments({
        ...shareFilter,
        createdAt: { $gte: last7d },
      }),
      this.transferModel.countDocuments(transferFilter),
      this.transferModel.countDocuments({ ...transferFilter, status: 'active' }),
      this.transferModel.countDocuments({
        ...transferFilter,
        createdAt: { $gte: last7d },
      }),
      this.linkModel.countDocuments(linkFilter),
      this.linkModel.countDocuments({ ...linkFilter, status: 'active' }),
      this.linkModel.countDocuments({
        ...linkFilter,
        createdAt: { $gte: last7d },
      }),
      this.sessionModel.countDocuments({ ...sessionFilter, status: 'uploading' }),
      this.countByField(this.transferModel, transferFilter, 'status'),
      this.countByField(this.linkModel, linkFilter, 'status'),
      this.countByField(this.linkModel, linkFilter, 'type'),
      this.linkModel.countDocuments({ ...linkFilter, type: 'transfer' }),
      this.linkModel.countDocuments({ ...linkFilter, type: 'share' }),
      isSuperAdmin ? this.getAuditLogs(currentUser, 10) : Promise.resolve([]),
      this.linkModel.aggregate<{ totalDownloads: number; totalViews: number }>([
        { $match: linkFilter },
        {
          $group: {
            _id: null,
            totalDownloads: { $sum: { $ifNull: ['$downloads', 0] } },
            totalViews: { $sum: { $ifNull: ['$views', 0] } },
          },
        },
      ]),
      this.transferModel.countDocuments({
        ...transferFilter,
        createdAt: { $gte: startOfToday },
      }),
      this.transferModel.aggregate<{ total: number }>([
        { $match: transferFilter },
        { $unwind: '$activity' },
        {
          $match: {
            'activity.action': 'download',
            'activity.createdAt': { $gte: startOfToday },
          },
        },
        { $count: 'total' },
      ]),
      this.userModel.countDocuments({
        ...userFilter,
        createdAt: { $gte: startOfToday },
      }),
      this.fileModel.countDocuments({
        ...fileFilter,
        isDeleted: false,
        createdAt: { $gte: startOfToday },
      }),
    ]);

    const totalBytes = totalStorage[0]?.totalBytes ?? 0;
    const transferStatus = this.countsToRecord(transfersByStatus, [
      'active',
      'expired',
      'disabled',
    ]);
    const linkStatus = this.countsToRecord(linksByStatus, [
      'active',
      'expired',
      'disabled',
    ]);
    const linkTypes = this.countsToRecord(linksByType, ['share', 'transfer']);
    const engagement = linkEngagement[0] ?? {
      totalDownloads: 0,
      totalViews: 0,
    };

    const flatOverview = {
      totalUsers,
      activeUsers,
      totalFiles,
      totalStorage: totalBytes,
      totalStorageUsed: totalBytes,
      totalTransfers,
      totalDownloads: engagement.totalDownloads,
      totalViews: engagement.totalViews,
      activeLinks,
      expiredLinks: linkStatus.expired,
      disabledLinks: linkStatus.disabled,
      newUsersToday,
      uploadsToday,
      recentUploads: uploadsToday,
      transfersToday,
      downloadsToday: downloadsToday[0]?.total ?? 0,
    };

    return {
      ...flatOverview,
      users: {
        total: totalUsers,
        active: activeUsers,
        inactive: totalUsers - activeUsers,
        ...(isSuperAdmin && {
          byRole: (usersByRole as { _id: string; count: number }[]).reduce<
            Record<string, number>
          >((acc, r) => { acc[r._id] = r.count; return acc; }, {}),
        }),
      },
      files: {
        total: totalFiles,
        inTrash: deletedFiles,
        uploadsLast7Days: uploadsLast7d,
        activeUploadSessions,
      },
      storage: {
        totalBytes,
        totalMB: +(totalBytes / 1024 ** 2).toFixed(2),
        totalGB: +(totalBytes / 1024 ** 3).toFixed(4),
      },
      shares: {
        total: totalShares,
        active: activeShares,
        createdLast7Days: sharesLast7d,
      },
      transfers: {
        total: totalTransfers,
        active: activeTransfers,
        expired: transferStatus.expired,
        disabled: transferStatus.disabled,
        createdLast7Days: transfersLast7d,
        byStatus: transferStatus,
      },
      links: {
        total: totalLinks,
        active: activeLinks,
        expired: linkStatus.expired,
        disabled: linkStatus.disabled,
        transfer: transferLinks,
        share: shareLinks,
        createdLast7Days: linksLast7d,
        byStatus: linkStatus,
        byType: linkTypes,
      },
      ...(isSuperAdmin && { auditLogs }),
    };
  }

  async getSuperAdminDashboard(currentUser: any) {
    const [
      overview,
      storage,
      sharing,
      activity,
      auditLogs,
      systemHealth,
      database,
      recentUsers,
      recentFiles,
      recentShares,
      recentTransfers,
      recentLinks,
      recentUploadSessions,
    ] = await Promise.all([
      this.getDashboardStats(currentUser),
      this.getStorageStats(currentUser),
      this.getShareAnalytics(currentUser),
      this.getActivityFeed(currentUser, 12),
      this.getAuditLogs(currentUser, 25),
      this.getSystemHealth(currentUser),
      this.getDatabaseStats(),
      this.getAllUsers(currentUser, { page: 1, limit: 6 } as AdminUsersDto),
      this.getAllFiles(currentUser, { page: 1, limit: 6 } as AdminFilesDto),
      this.getAllShares(currentUser, 1, 6),
      this.getAllTransfers(currentUser, { page: 1, limit: 6 } as AdminTransfersDto),
      this.getAllLinks(currentUser, { page: 1, limit: 6 } as AdminLinksDto),
      this.getAllUploadSessions(currentUser, { page: 1, limit: 6 } as AdminSessionsDto),
    ]);

    return {
      page: {
        title: 'Superadmin Dashboard',
        role: currentUser.role,
        generatedAt: new Date().toISOString(),
        scope: 'system',
      },
      cards: [
        {
          id: 'users',
          label: 'Users',
          value: overview.users.total,
          subValue: `${overview.users.active} active`,
          trendValue: overview.users.inactive,
          trendLabel: 'inactive',
        },
        {
          id: 'files',
          label: 'Files',
          value: overview.files.total,
          subValue: `${overview.files.uploadsLast7Days} uploaded in 7 days`,
          trendValue: overview.files.inTrash,
          trendLabel: 'in trash',
        },
        {
          id: 'storage',
          label: 'Storage',
          value: overview.storage.totalBytes,
          displayValue: `${overview.storage.totalGB} GB`,
          subValue: `${overview.storage.totalMB} MB used`,
        },
        {
          id: 'shares',
          label: 'Shares',
          value: overview.shares.total,
          subValue: `${overview.shares.active} active`,
          trendValue: overview.shares.createdLast7Days,
          trendLabel: 'created in 7 days',
        },
        {
          id: 'transfers',
          label: 'Transfers',
          value: overview.transfers.total,
          subValue: `${overview.transfers.active} active`,
          trendValue: overview.transfers.createdLast7Days,
          trendLabel: 'created in 7 days',
        },
        {
          id: 'links',
          label: 'Links',
          value: overview.links.total,
          subValue: `${overview.links.active} active`,
          trendValue: overview.links.createdLast7Days,
          trendLabel: 'created in 7 days',
        },
        {
          id: 'system',
          label: 'System',
          value: systemHealth.status,
          subValue: `${systemHealth.cpuUsage}% CPU / ${systemHealth.memoryUsage}% memory`,
        },
        {
          id: 'database',
          label: 'Database',
          value: database.status,
          subValue: `${database.collections} collections`,
        },
      ],
      overview,
      analytics: {
        storage,
        sharing,
      },
      recent: {
        activity,
        auditLogs,
        users: recentUsers.users,
        files: recentFiles.files,
        shares: recentShares.shares,
        transfers: recentTransfers.transfers,
        links: recentLinks.links,
        uploadSessions: recentUploadSessions.sessions,
      },
      operations: {
        systemHealth,
        database,
      },
      pagination: {
        users: recentUsers.pagination,
        files: recentFiles.pagination,
        shares: recentShares.pagination,
        transfers: recentTransfers.pagination,
        links: recentLinks.pagination,
        uploadSessions: recentUploadSessions.pagination,
      },
      quickActions: [
        { id: 'users', label: 'Manage users', href: '/admin/users' },
        { id: 'files', label: 'Review files', href: '/admin/files' },
        { id: 'transfers', label: 'Review transfers', href: '/admin/transfers' },
        { id: 'links', label: 'Review links', href: '/admin/links' },
        { id: 'audit', label: 'Open audit logs', href: '/admin/audit-logs' },
        { id: 'system', label: 'Check system health', href: '/admin/system' },
      ],
    };
  }

  /* =========================
     STORAGE ANALYTICS
  ========================= */
  async getStorageStats(currentUser: any) {
    const isSuperAdmin = currentUser.role === Role.SUPERADMIN;
    const baseMatch = isSuperAdmin ? {} : await this.buildUserScopeMatch(currentUser);

    const [summary, byCategory, byMimeType, topUsers, byFolder] = await Promise.all([
      this.fileModel.aggregate([
        { $match: { ...baseMatch, isDeleted: false } },
        {
          $group: {
            _id: null,
            totalSize: { $sum: '$size' },
            totalFiles: { $sum: 1 },
            avgSize: { $avg: '$size' },
            maxSize: { $max: '$size' },
          },
        },
      ]),

      this.fileModel.aggregate<RawStorageCategoryStat>([
        { $match: { ...baseMatch, isDeleted: false } },
        {
          $group: {
            _id: storageCategoryExpression(),
            count: { $sum: 1 },
            totalSize: { $sum: '$size' },
            avgSize: { $avg: '$size' },
            maxSize: { $max: '$size' },
          },
        },
        { $sort: { totalSize: -1 } },
      ]),

      this.fileModel.aggregate([
        { $match: { ...baseMatch, isDeleted: false } },
        {
          $group: {
            _id: '$mimeType',
            count: { $sum: 1 },
            totalSize: { $sum: '$size' },
          },
        },
        { $sort: { totalSize: -1 } },
        { $limit: 10 },
      ]),

      this.fileModel.aggregate([
        { $match: { ...baseMatch, isDeleted: false } },
        {
          $group: {
            _id: '$uploadedBy',
            fileCount: { $sum: 1 },
            totalSize: { $sum: '$size' },
          },
        },
        { $sort: { totalSize: -1 } },
        { $limit: 10 },
        {
          $lookup: {
            from: 'users',
            localField: '_id',
            foreignField: '_id',
            as: 'user',
          },
        },
        { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            fileCount: 1,
            totalSize: 1,
            'user.name': 1,
            'user.email': 1,
            'user.role': 1,
            'user.department': 1,
          },
        },
      ]),

      this.fileModel.aggregate([
        { $match: { ...baseMatch, isDeleted: false, folderId: { $ne: null } } },
        {
          $group: {
            _id: '$folderId',
            fileCount: { $sum: 1 },
            totalSize: { $sum: '$size' },
          },
        },
        { $sort: { totalSize: -1 } },
        { $limit: 10 },
        {
          $lookup: {
            from: 'folders',
            localField: '_id',
            foreignField: '_id',
            as: 'folder',
          },
        },
        { $unwind: { path: '$folder', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            fileCount: 1,
            totalSize: 1,
            'folder.name': 1,
            'folder.path': 1,
          },
        },
      ]),
    ]);

    const s = summary[0] ?? { totalSize: 0, totalFiles: 0, avgSize: 0, maxSize: 0 };

    return {
      summary: {
        totalSizeBytes: s.totalSize,
        totalSizeMB: +(s.totalSize / 1024 ** 2).toFixed(2),
        totalSizeGB: +(s.totalSize / 1024 ** 3).toFixed(4),
        totalFiles: s.totalFiles,
        avgFileSizeBytes: Math.round(s.avgSize ?? 0),
        largestFileSizeBytes: s.maxSize,
      },
      byCategory: buildStorageCategoryStats(byCategory, s.totalSize),
      byMimeType,
      topUsersByStorage: topUsers,
      topFoldersByStorage: byFolder,
    };
  }

  /* =========================
     USER MANAGEMENT
  ========================= */
  async getAllUsers(currentUser: any, dto: AdminUsersDto) {
    const isSuperAdmin = currentUser.role === Role.SUPERADMIN;
    const filter: any = isSuperAdmin ? {} : { createdBy: currentUser._id };

    if (dto.search) {
      filter.$or = [
        { name: { $regex: dto.search, $options: 'i' } },
        { email: { $regex: dto.search, $options: 'i' } },
      ];
    }

    if (dto.role !== undefined) filter.role = dto.role;
    if (dto.isActive !== undefined) filter.isActive = dto.isActive;

    const page = Math.max(1, dto.page ?? 1);
    const limit = Math.min(100, dto.limit ?? 20);
    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
      this.userModel
        .find(filter)
        .populate('createdBy', 'name email role')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.userModel.countDocuments(filter),
    ]);

    return {
      users,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /* =========================
     FILE MANAGEMENT
  ========================= */
  async getAllFiles(currentUser: any, dto: AdminFilesDto) {
    const isSuperAdmin = currentUser.role === Role.SUPERADMIN;
    const baseMatch = isSuperAdmin ? {} : await this.buildUserScopeMatch(currentUser);
    const filter: any = { ...baseMatch };

    if (!dto.includeTrashed) filter.isDeleted = false;

    if (dto.search) {
      filter.$or = [
        { fileName: { $regex: dto.search, $options: 'i' } },
        { originalName: { $regex: dto.search, $options: 'i' } },
      ];
    }

    if (dto.mimeType) {
      const escaped = dto.mimeType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.mimeType = { $regex: `^${escaped}`, $options: 'i' };
    }

    const page = Math.max(1, dto.page ?? 1);
    const limit = Math.min(100, dto.limit ?? 20);
    const skip = (page - 1) * limit;

    const [files, total] = await Promise.all([
      this.fileModel
        .find(filter)
        .populate('uploadedBy', 'name email role department')
        .populate('folderId', 'name path')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.fileModel.countDocuments(filter),
    ]);

    return {
      files,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /* =========================
     SHARE MANAGEMENT
  ========================= */
  async getAllShares(currentUser: any, page = 1, limit = 20) {
    const isSuperAdmin = currentUser.role === Role.SUPERADMIN;
    const filter: any = {};

    if (!isSuperAdmin) {
      const managedUserIds = await this.getManagedUserIds(currentUser._id);
      filter.createdBy = { $in: managedUserIds };
    }

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
     SHARE ANALYTICS
  ========================= */
  async getShareAnalytics(currentUser: any) {
    const isSuperAdmin = currentUser.role === Role.SUPERADMIN;
    const shareFilter: any = isSuperAdmin
      ? {}
      : { createdBy: { $in: await this.getManagedUserIds(currentUser._id) } };

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalShares,
      activeShares,
      byType,
      byPermission,
      byResourceType,
      totalCounts,
      topSharedFiles,
      deviceBreakdown,
      browserBreakdown,
      accessTrend,
    ] = await Promise.all([
      this.shareModel.countDocuments(shareFilter),
      this.shareModel.countDocuments({ ...shareFilter, isActive: true }),

      this.shareModel.aggregate([
        { $match: shareFilter },
        { $group: { _id: '$type', count: { $sum: 1 } } },
      ]),
      this.shareModel.aggregate([
        { $match: shareFilter },
        { $group: { _id: '$permission', count: { $sum: 1 } } },
      ]),
      this.shareModel.aggregate([
        { $match: shareFilter },
        { $group: { _id: '$resourceType', count: { $sum: 1 } } },
      ]),
      this.shareModel.aggregate([
        { $match: shareFilter },
        {
          $group: {
            _id: null,
            totalViews: { $sum: '$viewCount' },
            totalDownloads: { $sum: '$downloadCount' },
          },
        },
      ]),

      this.shareModel.aggregate([
        {
          $match: {
            ...shareFilter,
            resourceType: ResourceType.FILE,
            isActive: true,
          },
        },
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
            as: 'owner',
          },
        },
        { $unwind: { path: '$owner', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            shareToken: 1,
            type: 1,
            permission: 1,
            viewCount: 1,
            downloadCount: 1,
            expiresAt: 1,
            isActive: 1,
            'file.originalName': 1,
            'file.mimeType': 1,
            'file.size': 1,
            'owner.name': 1,
            'owner.email': 1,
          },
        },
      ]),

      this.shareAccessModel.aggregate([
        { $group: { _id: '$device', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      this.shareAccessModel.aggregate([
        { $group: { _id: '$browser', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      this.shareAccessModel.aggregate([
        { $match: { createdAt: { $gte: sevenDaysAgo } } },
        {
          $group: {
            _id: {
              date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
              action: '$action',
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.date': 1 } },
      ]),
    ]);

    const counts = totalCounts[0] ?? { totalViews: 0, totalDownloads: 0 };

    return {
      overview: {
        totalShares,
        activeShares,
        revokedShares: totalShares - activeShares,
        totalViews: counts.totalViews,
        totalDownloads: counts.totalDownloads,
      },
      breakdown: { byType, byPermission, byResourceType },
      topSharedFiles,
      accessTrend,
      deviceBreakdown,
      browserBreakdown,
    };
  }

  /* =========================
     TRANSFER MANAGEMENT
  ========================= */
  async getAllTransfers(currentUser: any, dto: AdminTransfersDto) {
    const isSuperAdmin = currentUser.role === Role.SUPERADMIN;
    const filter: any = {};

    if (!isSuperAdmin) {
      const managedUserIds = await this.getManagedUserIds(currentUser._id);
      filter.senderId = { $in: managedUserIds };
    }

    if (dto.status) filter.status = dto.status;
    if (dto.method) filter.method = dto.method;
    if (dto.search) {
      filter.$or = [
        { title: { $regex: dto.search, $options: 'i' } },
        { recipients: { $regex: dto.search, $options: 'i' } },
      ];
    }

    const page = Math.max(1, dto.page ?? 1);
    const limit = Math.min(100, dto.limit ?? 20);
    const skip = (page - 1) * limit;

    const [transfers, total, summary] = await Promise.all([
      this.transferModel
        .find(filter)
        .populate('senderId', 'name email role department')
        .populate('linkId', 'shortCode url qrCodeUrl status views downloads expiresAt hasPassword privacy fileCount totalSize')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-passwordHash -viewerDetails -activity')
        .lean(),
      this.transferModel.countDocuments(filter),
      this.transferModel.aggregate<{
        _id: null;
        active: number;
        expired: number;
        disabled: number;
        totalSize: number;
        totalViews: number;
        totalDownloads: number;
      }>([
        { $match: filter },
        {
          $group: {
            _id: null,
            active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
            expired: { $sum: { $cond: [{ $eq: ['$status', 'expired'] }, 1, 0] } },
            disabled: { $sum: { $cond: [{ $eq: ['$status', 'disabled'] }, 1, 0] } },
            totalSize: { $sum: '$totalSize' },
            totalViews: { $sum: '$views' },
            totalDownloads: { $sum: '$downloads' },
          },
        },
      ]),
    ]);

    return {
      transfers: transfers.map((transfer) => this.formatAdminTransfer(transfer)),
      summary: {
        total,
        active: summary[0]?.active ?? 0,
        expired: summary[0]?.expired ?? 0,
        disabled: summary[0]?.disabled ?? 0,
        totalSize: summary[0]?.totalSize ?? 0,
        totalViews: summary[0]?.totalViews ?? 0,
        totalDownloads: summary[0]?.totalDownloads ?? 0,
      },
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /* =========================
     LINK MANAGEMENT
  ========================= */
  async getAllLinks(currentUser: any, dto: AdminLinksDto) {
    const isSuperAdmin = currentUser.role === Role.SUPERADMIN;
    const filter: any = {};

    if (!isSuperAdmin) {
      const managedUserIds = await this.getManagedUserIds(currentUser._id);
      filter.senderId = { $in: managedUserIds };
    }

    if (dto.status) filter.status = dto.status;
    if (dto.type) filter.type = dto.type;
    if (dto.method) filter.method = dto.method;
    if (dto.permission) filter.permission = dto.permission;
    if (dto.search) {
      filter.$or = [
        { shortCode: { $regex: dto.search, $options: 'i' } },
        { url: { $regex: dto.search, $options: 'i' } },
      ];
    }

    const page = Math.max(1, dto.page ?? 1);
    const limit = Math.min(100, dto.limit ?? 20);
    const skip = (page - 1) * limit;

    const [links, total, summary, byType, byMethod] = await Promise.all([
      this.linkModel
        .find(filter)
        .populate('senderId', 'name email role department')
        .populate('transferId', 'title method recipients fileCount folderCount totalSize status expiresAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-passwordHash')
        .lean(),
      this.linkModel.countDocuments(filter),
      this.linkModel.aggregate<{
        _id: null;
        active: number;
        expired: number;
        disabled: number;
        totalViews: number;
        totalDownloads: number;
        totalSize: number;
      }>([
        { $match: filter },
        {
          $group: {
            _id: null,
            active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
            expired: { $sum: { $cond: [{ $eq: ['$status', 'expired'] }, 1, 0] } },
            disabled: { $sum: { $cond: [{ $eq: ['$status', 'disabled'] }, 1, 0] } },
            totalViews: { $sum: '$views' },
            totalDownloads: { $sum: '$downloads' },
            totalSize: { $sum: '$totalSize' },
          },
        },
      ]),
      this.countByField(this.linkModel, filter, 'type'),
      this.countByField(this.linkModel, filter, 'method'),
    ]);

    const statusSummary = summary[0] ?? {
      active: 0,
      expired: 0,
      disabled: 0,
      totalViews: 0,
      totalDownloads: 0,
      totalSize: 0,
    };

    return {
      links: links.map((link) => this.formatAdminLink(link)),
      summary: {
        total,
        active: statusSummary.active,
        expired: statusSummary.expired,
        disabled: statusSummary.disabled,
        totalViews: statusSummary.totalViews,
        totalDownloads: statusSummary.totalDownloads,
        totalSize: statusSummary.totalSize,
        byType: this.countsToRecord(byType, ['share', 'transfer']),
        byMethod: this.countsToRecord(byMethod, ['email', 'link', 'qr']),
      },
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /* =========================
     UPLOAD SESSION MANAGEMENT
  ========================= */
  async getAllUploadSessions(currentUser: any, dto: AdminSessionsDto) {
    const isSuperAdmin = currentUser.role === Role.SUPERADMIN;
    const filter: any = {};

    if (!isSuperAdmin) {
      const managedUserIds = await this.getManagedUserIds(currentUser._id);
      filter.userId = { $in: managedUserIds };
    }

    if (dto.status) filter.status = dto.status;

    const page = Math.max(1, dto.page ?? 1);
    const limit = Math.min(100, dto.limit ?? 20);
    const skip = (page - 1) * limit;

    const [sessions, total] = await Promise.all([
      this.sessionModel
        .find(filter)
        .populate('userId', 'name email role')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.sessionModel.countDocuments(filter),
    ]);

    return {
      sessions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /* =========================
     ACTIVITY FEED
  ========================= */
  async getActivityFeed(currentUser: any, limit = 50) {
    const isSuperAdmin = currentUser.role === Role.SUPERADMIN;
    const managedIds = isSuperAdmin ? null : await this.getManagedUserIds(currentUser._id);

    const fileFilter = managedIds
      ? { uploadedBy: { $in: managedIds }, isDeleted: false }
      : { isDeleted: false };
    const transferFilter = managedIds ? { senderId: { $in: managedIds } } : {};

    const perSource = Math.ceil(limit * 0.4);

    const [recentFiles, recentTransfers, recentUsers] = await Promise.all([
      this.fileModel
        .find(fileFilter)
        .sort({ createdAt: -1 })
        .limit(perSource)
        .populate('uploadedBy', 'name email')
        .select('fileName originalName mimeType size createdAt uploadedBy folderId')
        .lean(),

      this.transferModel
        .find(transferFilter)
        .sort({ createdAt: -1 })
        .limit(perSource)
        .populate('senderId', 'name email')
        .select('title method fileCount totalSize status createdAt senderId recipients')
        .lean(),

      isSuperAdmin
        ? this.userModel
            .find({})
            .sort({ createdAt: -1 })
            .limit(Math.ceil(limit * 0.2))
            .select('name email role createdAt')
            .lean()
        : Promise.resolve([]),
    ]);

    const events: { type: string; createdAt: Date; data: any }[] = [
      ...recentFiles.map((f) => ({
        type: 'file_upload',
        createdAt: (f as any).createdAt,
        data: f,
      })),
      ...recentTransfers.map((t) => ({
        type: 'transfer_created',
        createdAt: (t as any).createdAt,
        data: t,
      })),
      ...recentUsers.map((u) => ({
        type: 'user_registered',
        createdAt: (u as any).createdAt,
        data: u,
      })),
    ];

    return events
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }

  async getAuditLogs(currentUser: any, limit = 100) {
    const isSuperAdmin = currentUser.role === Role.SUPERADMIN;
    const managedIds = isSuperAdmin ? null : await this.getManagedUserIds(currentUser._id);

    const userFilter = isSuperAdmin ? {} : { createdBy: currentUser._id };
    const fileFilter = managedIds ? { uploadedBy: { $in: managedIds } } : {};
    const shareFilter = managedIds ? { createdBy: { $in: managedIds } } : {};
    const transferFilter = managedIds ? { senderId: { $in: managedIds } } : {};
    const linkFilter = managedIds ? { senderId: { $in: managedIds } } : {};
    const sessionFilter = managedIds ? { userId: { $in: managedIds } } : {};
    const perSource = Math.max(5, Math.ceil(limit / 6));

    const [
      recentUsers,
      recentFiles,
      recentShares,
      recentTransfers,
      recentLinks,
      recentSessions,
    ] = await Promise.all([
      this.userModel
        .find(userFilter)
        .sort({ createdAt: -1 })
        .limit(perSource)
        .populate('createdBy', 'name email role department')
        .select('name email role department isActive createdAt createdBy')
        .lean(),

      this.fileModel
        .find(fileFilter)
        .sort({ createdAt: -1 })
        .limit(perSource)
        .populate('uploadedBy', 'name email role department')
        .select('fileName originalName mimeType size isDeleted createdAt uploadedBy folderId')
        .lean(),

      this.shareModel
        .find(shareFilter)
        .sort({ createdAt: -1 })
        .limit(perSource)
        .populate('createdBy', 'name email role department')
        .select('name type resourceType permission isActive createdAt createdBy fileId folderId')
        .lean(),

      this.transferModel
        .find(transferFilter)
        .sort({ createdAt: -1 })
        .limit(perSource)
        .populate('senderId', 'name email role department')
        .select('title method status privacy fileCount folderCount totalSize createdAt senderId')
        .lean(),

      this.linkModel
        .find(linkFilter)
        .sort({ createdAt: -1 })
        .limit(perSource)
        .populate('senderId', 'name email role department')
        .select('shortCode type method permission status privacy fileCount totalSize createdAt senderId')
        .lean(),

      this.sessionModel
        .find(sessionFilter)
        .sort({ createdAt: -1 })
        .limit(perSource)
        .populate('userId', 'name email role department')
        .select('fileName mimeType size uploadType status partsCount createdAt userId')
        .lean(),
    ]);

    const events: AuditLogEvent[] = [
      ...recentUsers.map((user: any) =>
        this.createAuditEvent({
          action: 'user_created',
          resourceType: 'user',
          resource: user,
          actor: user.createdBy,
          message: `User created: ${user.name ?? user.email ?? 'unknown user'}`,
          metadata: {
            email: user.email,
            role: user.role,
            department: user.department,
            isActive: user.isActive,
          },
        }),
      ),
      ...recentFiles.map((file: any) =>
        this.createAuditEvent({
          action: file.isDeleted ? 'file_deleted' : 'file_uploaded',
          resourceType: 'file',
          resource: file,
          actor: file.uploadedBy,
          message: `${file.isDeleted ? 'File moved to trash' : 'File uploaded'}: ${
            file.fileName ?? file.originalName ?? 'unknown file'
          }`,
          metadata: {
            fileName: file.fileName ?? file.originalName,
            mimeType: file.mimeType,
            size: file.size,
            folderId: file.folderId?.toString?.() ?? null,
            isDeleted: file.isDeleted,
          },
        }),
      ),
      ...recentShares.map((share: any) =>
        this.createAuditEvent({
          action: 'share_created',
          resourceType: 'share',
          resource: share,
          actor: share.createdBy,
          message: `Share created: ${share.name ?? share.type ?? 'share'}`,
          metadata: {
            type: share.type,
            resourceType: share.resourceType,
            permission: share.permission,
            isActive: share.isActive,
            fileId: share.fileId?.toString?.() ?? null,
            folderId: share.folderId?.toString?.() ?? null,
          },
        }),
      ),
      ...recentTransfers.map((transfer: any) =>
        this.createAuditEvent({
          action: 'transfer_created',
          resourceType: 'transfer',
          resource: transfer,
          actor: transfer.senderId,
          message: `Transfer created: ${transfer.title ?? 'untitled transfer'}`,
          metadata: {
            method: transfer.method,
            status: transfer.status,
            privacy: transfer.privacy,
            fileCount: transfer.fileCount ?? 0,
            folderCount: transfer.folderCount ?? 0,
            totalSize: transfer.totalSize ?? 0,
          },
        }),
      ),
      ...recentLinks.map((link: any) =>
        this.createAuditEvent({
          action: 'link_created',
          resourceType: 'link',
          resource: link,
          actor: link.senderId,
          message: `Link created: ${link.shortCode ?? 'unknown link'}`,
          metadata: {
            shortCode: link.shortCode,
            type: link.type,
            method: link.method,
            permission: link.permission,
            status: link.status,
            privacy: link.privacy,
            fileCount: link.fileCount ?? 0,
            totalSize: link.totalSize ?? 0,
          },
        }),
      ),
      ...recentSessions.map((session: any) =>
        this.createAuditEvent({
          action: `upload_session_${session.status ?? 'created'}`,
          resourceType: 'upload_session',
          resource: session,
          actor: session.userId,
          message: `Upload session ${session.status ?? 'created'}: ${
            session.fileName ?? 'unknown file'
          }`,
          metadata: {
            fileName: session.fileName,
            mimeType: session.mimeType,
            size: session.size,
            uploadType: session.uploadType,
            status: session.status,
            partsCount: session.partsCount ?? 0,
          },
        }),
      ),
    ];

    return events
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }

  /* =========================
     PRIVATE HELPERS
  ========================= */
  private async getManagedUserIds(adminId: any): Promise<Types.ObjectId[]> {
    const adminObjectId = this.toObjectId(adminId);
    const users = await this.userModel.find({ createdBy: adminObjectId }).select('_id');
    const ids = users.map((u) => u._id as Types.ObjectId);
    ids.push(adminObjectId);
    return ids;
  }

  private async buildUserScopeMatch(currentUser: any): Promise<Record<string, any>> {
    return { uploadedBy: this.toObjectId(currentUser._id) };
  }

  private toObjectId(id: any): Types.ObjectId {
    if (id instanceof Types.ObjectId) return id;
    return new Types.ObjectId(id?.toString());
  }

  private async countByField(
    model: Model<any>,
    filter: Record<string, any>,
    field: string,
  ): Promise<CountById[]> {
    return model.aggregate<CountById>([
      { $match: filter },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    ]);
  }

  private countsToRecord(rows: CountById[], defaults: string[] = []) {
    return rows.reduce<Record<string, number>>((acc, row) => {
      if (row._id) acc[row._id] = row.count;
      return acc;
    }, Object.fromEntries(defaults.map((key) => [key, 0])));
  }

  private formatUser(user: any): UserSummary | null {
    if (!user || typeof user !== 'object') return null;
    return {
      id: user._id?.toString?.() ?? user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      department: user.department,
    };
  }

  private createAuditEvent(params: {
    action: string;
    resourceType: string;
    resource: any;
    actor: any;
    message: string;
    metadata: Record<string, any>;
  }): AuditLogEvent {
    const resourceId = params.resource?._id?.toString?.() ?? params.resource?.id ?? null;

    return {
      id: `${params.resourceType}:${resourceId ?? 'unknown'}:${params.action}`,
      action: params.action,
      resourceType: params.resourceType,
      resourceId,
      actor: this.formatUser(params.actor),
      message: params.message,
      metadata: params.metadata,
      createdAt: params.resource?.createdAt ?? new Date(0),
    };
  }

  private formatAdminTransfer(transfer: any) {
    const link =
      transfer.linkId && typeof transfer.linkId === 'object' ? transfer.linkId : null;

    return {
      id: transfer._id?.toString?.() ?? transfer.id,
      title: transfer.title,
      subject: transfer.subject,
      message: transfer.message,
      method: transfer.method,
      status: transfer.status,
      privacy: transfer.privacy,
      sender: this.formatUser(transfer.senderId),
      recipients: transfer.recipients ?? [],
      fileCount: transfer.fileCount ?? 0,
      folderCount: transfer.folderCount ?? 0,
      totalSize: transfer.totalSize ?? 0,
      views: transfer.views ?? 0,
      downloads: transfer.downloads ?? 0,
      hasPassword: transfer.hasPassword ?? false,
      expiresAt: transfer.expiresAt,
      lastViewedAt: transfer.lastViewedAt,
      lastDownloadedAt: transfer.lastDownloadedAt,
      createdAt: transfer.createdAt,
      updatedAt: transfer.updatedAt,
      link: link
        ? {
            id: link._id?.toString?.() ?? link.id,
            shortCode: link.shortCode,
            url: link.url,
            qrCodeUrl: link.qrCodeUrl,
            status: link.status,
            views: link.views ?? 0,
            downloads: link.downloads ?? 0,
            expiresAt: link.expiresAt,
            hasPassword: link.hasPassword ?? false,
            privacy: link.privacy,
            fileCount: link.fileCount ?? 0,
            totalSize: link.totalSize ?? 0,
          }
        : null,
    };
  }

  private formatAdminLink(link: any) {
    const transfer =
      link.transferId && typeof link.transferId === 'object' ? link.transferId : null;

    return {
      id: link._id?.toString?.() ?? link.id,
      shortCode: link.shortCode,
      url: link.url,
      qrCodeUrl: link.qrCodeUrl,
      type: link.type,
      method: link.method,
      permission: link.permission,
      status: link.status,
      privacy: link.privacy,
      sender: this.formatUser(link.senderId),
      transfer: transfer
        ? {
            id: transfer._id?.toString?.() ?? transfer.id,
            title: transfer.title,
            method: transfer.method,
            status: transfer.status,
            recipients: transfer.recipients ?? [],
            fileCount: transfer.fileCount ?? 0,
            folderCount: transfer.folderCount ?? 0,
            totalSize: transfer.totalSize ?? 0,
            expiresAt: transfer.expiresAt,
          }
        : null,
      transferId: transfer?._id?.toString?.() ?? link.transferId?.toString?.() ?? null,
      fileIds: (link.fileIds ?? []).map((id: any) => id?.toString?.() ?? id),
      folderIds: (link.folderIds ?? []).map((id: any) => id?.toString?.() ?? id),
      fileCount: link.fileCount ?? 0,
      totalSize: link.totalSize ?? 0,
      views: link.views ?? 0,
      downloads: link.downloads ?? 0,
      lastViewedAt: link.lastViewedAt,
      lastDownloadedAt: link.lastDownloadedAt,
      expiresAt: link.expiresAt,
      hasPassword: link.hasPassword ?? false,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt,
    };
  }
}
