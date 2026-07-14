import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { Folder, FolderDocument } from './schemas/folder.schema';
import { FileRecord, FileDocument } from '../files/schemas/file.schema';
import { CreateFolderDto, UpdateFolderDto, ListFoldersDto } from './dto/folder.dto';
import { Role } from '../common/enums';

@Injectable()
export class FoldersService {
  private readonly logger = new Logger(FoldersService.name);

  constructor(
    @InjectModel(Folder.name)
    private readonly folderModel: Model<FolderDocument>,
    @InjectModel(FileRecord.name)
    private readonly fileModel: Model<FileDocument>,
  ) {}

  /* ═══════════════════════════════════════
     CREATE
  ═══════════════════════════════════════ */
  async create(dto: CreateFolderDto, user: any): Promise<FolderDocument> {
    const userId = this.uid(user);

    let parentId: Types.ObjectId | null = null;
    let path = '/';

    if (dto.parentId) {
      const parent = await this.folderModel.findOne({
        _id: dto.parentId,
        isDeleted: false,
      });
      if (!parent) throw new NotFoundException('Parent folder not found');
      this.verifyAccess(parent, user);
      parentId = this.oid(dto.parentId);
      path = this.fullPath(parent);
    }

    const exists = await this.folderModel.findOne({
      name: dto.name,
      parentId,
      createdBy: this.oid(userId),
      isDeleted: false,
    });
    if (exists) {
      throw new ConflictException({
        statusCode: 409,
        message: 'A folder with this name already exists here',
        id: (exists._id as any).toString(),
      });
    }

    return this.folderModel.create({
      name: dto.name,
      parentId,
      createdBy: this.oid(userId),
      organizationId: user.organizationId ? new Types.ObjectId(user.organizationId) : null,
      description: dto.description ?? '',
      color: dto.color ?? null,
      path,
      status: 'active',
    });
  }

  /* ═══════════════════════════════════════
     LIST (flat, paginated, searchable)
  ═══════════════════════════════════════ */
  async findAll(user: any, dto: ListFoldersDto = {}) {
    const page = Math.max(1, dto.page ?? 1);
    const limit = Math.min(Math.max(1, dto.limit ?? 50), 200);
    const skip = (page - 1) * limit;

    const filter: Record<string, any> = { isDeleted: false };

    if (user.role !== Role.SUPERADMIN) {
      filter.createdBy = this.oid(this.uid(user));
    }

    if (dto.parentId !== undefined) {
      filter.parentId = dto.parentId
        ? this.oid(dto.parentId)
        : null;
    }

    if (dto.search) {
      filter.name = { $regex: this.escapeRegex(dto.search), $options: 'i' };
    }

    const [folders, total] = await Promise.all([
      this.folderModel
        .find(filter)
        .populate('createdBy', 'name email role')
        .sort({ path: 1, name: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.folderModel.countDocuments(filter),
    ]);

    return {
      folders,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /* ═══════════════════════════════════════
     GET ONE
  ═══════════════════════════════════════ */
  async findOne(id: string, user: any): Promise<FolderDocument> {
    const folder = await this.folderModel
      .findOne({ _id: id, isDeleted: false })
      .populate('createdBy', 'name email role')
      .populate('parentId', 'name path');

    if (!folder) throw new NotFoundException('Folder not found');
    this.verifyAccess(folder, user);
    return folder;
  }

  /* ═══════════════════════════════════════
     TREE (recursive)
  ═══════════════════════════════════════ */
  async getFolderTree(user: any): Promise<any[]> {
    const filter: Record<string, any> = { isDeleted: false };

    if (user.role !== Role.SUPERADMIN) {
      filter.createdBy = this.oid(this.uid(user));
    }

    const folders = await this.folderModel.find(filter).lean();
    return this.buildTree(folders, null);
  }

  /* ═══════════════════════════════════════
     FOLDER CONTENTS — subfolders + files + breadcrumb
  ═══════════════════════════════════════ */
  async getContents(id: string, user: any) {
    const folder = await this.findOne(id, user);
    const folderId = folder._id as Types.ObjectId;

    /* Direct subfolders with per-subfolder counts */
    const rawSubfolders = await this.folderModel
      .find({
        parentId: folderId,
        isDeleted: false,
        ...this.ownerFilter(user),
      })
      .populate('createdBy', 'name email role')
      .sort({ name: 1 })
      .lean();

    const subfolders = await Promise.all(
      rawSubfolders.map(async (sub) => {
        const [fileCount, subfolderCount] = await Promise.all([
          this.fileModel.countDocuments({
            folderId: sub._id,
            isDeleted: false,
            ...this.fileOwnerFilter(user),
          }),
          this.folderModel.countDocuments({
            parentId: sub._id,
            isDeleted: false,
            ...this.ownerFilter(user),
          }),
        ]);
        return {
          id: (sub._id as any).toString(),
          name: sub.name,
          path: sub.path,
          description: sub.description,
          color: sub.color ?? null,
          createdBy: sub.createdBy,
          createdAt: (sub as any).createdAt,
          updatedAt: (sub as any).updatedAt,
          fileCount,
          subfolderCount,
          hasChildren: fileCount > 0 || subfolderCount > 0,
        };
      }),
    );

    /* Files directly in this folder */
    const files = await this.fileModel
      .find({ folderId, isDeleted: false, ...this.fileOwnerFilter(user) })
      .populate('uploadedBy', 'name email')
      .sort({ createdAt: -1 })
      .lean();

    /* Breadcrumb: root → folder */
    const breadcrumb = await this.buildBreadcrumb(folder);

    /* Total descendant file count */
    const allDescendantIds = await this.getDescendantIds(folder);
    const totalDescendantFiles = await this.fileModel.countDocuments({
      folderId: { $in: [folderId, ...allDescendantIds] },
      isDeleted: false,
      ...this.fileOwnerFilter(user),
    });

    return {
      folder: {
        id: folderId.toString(),
        name: folder.name,
        path: folder.path,
        description: folder.description,
        color: (folder as any).color ?? null,
        createdBy: (folder as any).createdBy,
        parentId: folder.parentId?.toString() ?? null,
        createdAt: (folder as any).createdAt,
        updatedAt: (folder as any).updatedAt,
      },
      breadcrumb,
      subfolders,
      files: files.map((f) => this.toFileDto(f)),
      stats: {
        subfolderCount: rawSubfolders.length,
        fileCount: files.length,
        totalDescendantFiles,
      },
    };
  }

  /* ═══════════════════════════════════════
     UPDATE  — cascades path when name changes
  ═══════════════════════════════════════ */
  async update(id: string, dto: UpdateFolderDto, user: any): Promise<FolderDocument> {
    const folder = await this.findOne(id, user);
    this.verifyAccess(folder, user);

    const updates: Record<string, unknown> = {};

    if (dto.description !== undefined) updates.description = dto.description;
    if (dto.color !== undefined) updates.color = dto.color;

    if (dto.name !== undefined && dto.name !== folder.name) {
      /* Duplicate name check */
      const dup = await this.folderModel.findOne({
        name: dto.name,
        parentId: folder.parentId,
        createdBy: folder.createdBy,
        _id: { $ne: folder._id },
        isDeleted: false,
      });
      if (dup) throw new ConflictException('A folder with this name already exists here');

      updates.name = dto.name;

      /* Cascade path update to all descendants */
      const oldFullPath = this.fullPath(folder);
      const newFullPath = `${folder.path}${dto.name}/`;

      if (oldFullPath !== newFullPath) {
        await this.folderModel.updateMany(
          {
            createdBy: folder.createdBy,
            path: { $regex: `^${this.escapeRegex(oldFullPath)}` },
          },
          [{ $set: { path: { $replaceOne: { input: '$path', find: oldFullPath, replacement: newFullPath } } } }],
        );
      }
    }

    if (Object.keys(updates).length === 0) {
      throw new BadRequestException('No valid fields to update');
    }

    const updated = await this.folderModel
      .findByIdAndUpdate(id, { $set: updates }, { new: true })
      .exec();

    if (!updated) throw new NotFoundException('Folder not found');
    return updated;
  }

  /* ═══════════════════════════════════════
     MOVE  — guards against circular dependency
  ═══════════════════════════════════════ */
  async moveFolder(
    id: string,
    newParentId: string | null,
    user: any,
  ): Promise<FolderDocument> {
    const folder = await this.findOne(id, user);
    this.verifyAccess(folder, user);

    if (newParentId && newParentId === id) {
      throw new BadRequestException('Cannot move a folder into itself');
    }

    let parentOid: Types.ObjectId | null = null;
    let newPath = '/';

    if (newParentId) {
      const parent = await this.folderModel.findOne({
        _id: newParentId,
        isDeleted: false,
        ...this.ownerFilter(user),
      }).lean();

      if (!parent) throw new NotFoundException('Destination folder not found');

      /* Circular dependency check: target must not be a descendant */
      const oldFullPath = this.fullPath(folder);
      if (parent.path.startsWith(oldFullPath) || parent.path === oldFullPath) {
        throw new BadRequestException(
          'Cannot move a folder into one of its own descendants',
        );
      }

      parentOid = this.oid(newParentId);
      newPath = `${parent.path}${parent.name}/`;
    }

    const oldFullPath = this.fullPath(folder);
    const newFullPath = `${newPath}${folder.name}/`;

    const updated = await this.folderModel.findByIdAndUpdate(
      id,
      { $set: { parentId: parentOid, path: newPath } },
      { new: true },
    );

    if (!updated) throw new NotFoundException('Folder not found after update');

    /* Cascade path change to all descendants */
    if (oldFullPath !== newFullPath) {
      await this.folderModel.updateMany(
        {
          createdBy: folder.createdBy,
          path: { $regex: `^${this.escapeRegex(oldFullPath)}` },
        },
        [{ $set: { path: { $replaceOne: { input: '$path', find: oldFullPath, replacement: newFullPath } } } }],
      );
    }

    return updated;
  }

  /* ═══════════════════════════════════════
     SOFT DELETE  (cascades to descendants + files)
  ═══════════════════════════════════════ */
  async softDelete(id: string, user: any) {
    const folder = await this.findOne(id, user);
    this.verifyAccess(folder, user);

    const now = new Date();
    const fullPath = this.fullPath(folder);

    const descendants = await this.folderModel
      .find({
        createdBy: folder.createdBy,
        path: { $regex: `^${this.escapeRegex(fullPath)}` },
        isDeleted: false,
      })
      .lean();

    const allIds = [
      folder._id as Types.ObjectId,
      ...descendants.map((d) => d._id as Types.ObjectId),
    ];

    const [folderResult, fileResult] = await Promise.all([
      this.folderModel.updateMany(
        { _id: { $in: allIds } },
        { $set: { isDeleted: true, status: 'trashed', deletedAt: now } },
      ),
      this.fileModel.updateMany(
        {
          folderId: { $in: allIds },
          isDeleted: false,
          ...this.fileOwnerFilter(user),
        },
        { $set: { isDeleted: true, status: 'trashed', deletedAt: now } },
      ),
    ]);

    this.logger.log(
      `Soft-deleted folder tree | root=${id} | folders=${folderResult.modifiedCount} | files=${fileResult.modifiedCount}`,
    );

    return {
      message: `Folder moved to trash. ${descendants.length} subfolder(s) and ${fileResult.modifiedCount} file(s) also trashed.`,
      deletedFolders: folderResult.modifiedCount,
      deletedFiles: fileResult.modifiedCount,
    };
  }

  /* ═══════════════════════════════════════
     RESTORE  (cascades to descendants + files)
  ═══════════════════════════════════════ */
  async restore(id: string, user: any) {
    const folder = await this.folderModel.findById(id);
    if (!folder) throw new NotFoundException('Folder not found');

    const isOwner = folder.createdBy.toString() === this.uid(user);
    const isAdmin = user.role === Role.SUPERADMIN;
    if (!isOwner && !isAdmin) throw new ForbiddenException('Access denied');

    /* If the parent is still deleted, restore at root instead */
    let restorePath = folder.path;
    let restoreParentId = folder.parentId;

    if (folder.parentId) {
      const parent = await this.folderModel.findById(folder.parentId).lean();
      if (!parent || parent.isDeleted) {
        restorePath = '/';
        restoreParentId = null;
      }
    }

    const oldFullPath = this.fullPath(folder);
    const newFullPath = `${restorePath}${folder.name}/`;
    const pathChanged = oldFullPath !== newFullPath;

    /* Restore root folder */
    await this.folderModel.findByIdAndUpdate(id, {
      $set: {
        isDeleted: false,
        status: 'active',
        deletedAt: null,
        path: restorePath,
        parentId: restoreParentId,
      },
    });

    /* Restore all descendants */
    const descendants = await this.folderModel
      .find({
        createdBy: folder.createdBy,
        path: { $regex: `^${this.escapeRegex(oldFullPath)}` },
        isDeleted: true,
      })
      .lean();

    const descendantIds = descendants.map((d) => d._id as Types.ObjectId);

    const allIds = [folder._id as Types.ObjectId, ...descendantIds];

    const [folderResult, fileResult] = await Promise.all([
      this.folderModel.updateMany(
        { _id: { $in: descendantIds } },
        { $set: { isDeleted: false, status: 'active', deletedAt: null } },
      ),
      this.fileModel.updateMany(
        {
          folderId: { $in: allIds },
          isDeleted: true,
          ...this.fileOwnerFilter(user),
        },
        { $set: { isDeleted: false, status: 'active', deletedAt: null } },
      ),
    ]);

    /* Fix descendant paths if root moved */
    if (pathChanged && descendantIds.length > 0) {
      await this.folderModel.updateMany(
        { _id: { $in: descendantIds } },
        [{ $set: { path: { $replaceOne: { input: '$path', find: oldFullPath, replacement: newFullPath } } } }],
      );
    }

    this.logger.log(
      `Restored folder tree | root=${id} | folders=${folderResult.modifiedCount + 1} | files=${fileResult.modifiedCount}`,
    );

    return {
      message: `Folder restored. ${folderResult.modifiedCount} subfolder(s) and ${fileResult.modifiedCount} file(s) also restored.`,
      restoredFolders: folderResult.modifiedCount + 1,
      restoredFiles: fileResult.modifiedCount,
    };
  }

  /* ═══════════════════════════════════════
     HARD DELETE  (owner or superadmin — permanent)
  ═══════════════════════════════════════ */
  async hardDelete(id: string, user: any) {
    const folder = await this.folderModel.findById(id);
    if (!folder) throw new NotFoundException('Folder not found');
    this.verifyAccess(folder, user);

    const fullPath = this.fullPath(folder);

    const descendants = await this.folderModel
      .find({
        createdBy: folder.createdBy,
        path: { $regex: `^${this.escapeRegex(fullPath)}` },
      })
      .lean();

    const allIds = [
      folder._id as Types.ObjectId,
      ...descendants.map((d) => d._id as Types.ObjectId),
    ];

    const [folderResult, fileResult] = await Promise.all([
      this.folderModel.deleteMany({ _id: { $in: allIds } }),
      this.fileModel.deleteMany({ folderId: { $in: allIds } }),
    ]);

    this.logger.warn(
      `Hard-deleted folder tree | root=${id} | folders=${folderResult.deletedCount} | files=${fileResult.deletedCount}`,
    );

    return {
      message: `Folder permanently deleted along with ${descendants.length} subfolder(s) and ${fileResult.deletedCount} file(s).`,
      deletedFolders: folderResult.deletedCount,
      deletedFiles: fileResult.deletedCount,
    };
  }

  /* ═══════════════════════════════════════
     TRASH LIST
  ═══════════════════════════════════════ */
  async getTrashed(user: any) {
    const filter: Record<string, any> = { isDeleted: true };

    if (user.role !== Role.SUPERADMIN) {
      filter.createdBy = this.oid(this.uid(user));
    }

    const folders = await this.folderModel
      .find(filter)
      .sort({ deletedAt: -1 })
      .lean();

    return folders;
  }

  /* ═══════════════════════════════════════
     ADMIN STATS
  ═══════════════════════════════════════ */
  async getAdminStats() {
    const [total, active, trashed, withFiles] = await Promise.all([
      this.folderModel.countDocuments(),
      this.folderModel.countDocuments({ isDeleted: false }),
      this.folderModel.countDocuments({ isDeleted: true }),
      this.folderModel.countDocuments({
        _id: { $in: await this.fileModel.distinct('folderId', { isDeleted: false }) },
      }),
    ]);

    return { total, active, trashed, empty: active - withFiles };
  }

  /* ═══════════════════════════════════════
     PRIVATE — HELPERS
  ═══════════════════════════════════════ */
  private uid(user: any): string {
    return (user._id ?? user.userId)?.toString();
  }

  private oid(id: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Invalid ID');
    return new Types.ObjectId(id);
  }

  /** Full path this folder occupies: path + name + "/" */
  private fullPath(folder: Pick<Folder, 'path' | 'name'>): string {
    return `${folder.path}${folder.name}/`;
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private verifyAccess(folder: FolderDocument, user: any): void {
    const userId = this.uid(user);
    const isOwner = folder.createdBy.toString() === userId;
    const isAdmin = user.role === Role.SUPERADMIN;
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('You do not have access to this folder');
    }
  }

  private ownerFilter(user: any): Record<string, unknown> {
    return user.role === Role.SUPERADMIN
      ? {}
      : { createdBy: this.oid(this.uid(user)) };
  }

  private fileOwnerFilter(user: any): Record<string, unknown> {
    return user.role === Role.SUPERADMIN
      ? {}
      : { uploadedBy: this.oid(this.uid(user)) };
  }

  private buildTree(folders: any[], parentId: any): any[] {
    return folders
      .filter((f) =>
        parentId === null
          ? !f.parentId
          : f.parentId?.toString() === parentId?.toString(),
      )
      .map((f) => ({ ...f, children: this.buildTree(folders, f._id) }));
  }

  private async buildBreadcrumb(folder: any): Promise<{ id: string; name: string }[]> {
    const crumbs: { id: string; name: string }[] = [];
    let current = folder;

    while (current.parentId) {
      const parent: { _id: any; name: string; parentId: any } | null =
        await this.folderModel
          .findOne({ _id: current.parentId, isDeleted: false })
          .lean<{ _id: any; name: string; parentId: any }>();
      if (!parent) break;
      crumbs.unshift({ id: parent._id.toString(), name: parent.name });
      current = parent;
    }

    return crumbs;
  }

  private async getDescendantIds(folder: any): Promise<Types.ObjectId[]> {
    const descendants = await this.folderModel
      .find({
        createdBy: folder.createdBy,
        path: { $regex: `^${this.escapeRegex(this.fullPath(folder))}` },
        isDeleted: false,
      })
      .select('_id')
      .lean();

    return descendants.map((d) => d._id as Types.ObjectId);
  }

  private toFileDto(raw: any): any {
    const id = raw._id?.toString() ?? '';
    const ext = (raw.originalName ?? raw.fileName ?? '').split('.').pop()?.toLowerCase() ?? '';
    return {
      ...raw,
      id,
      name: raw.fileName ?? raw.name ?? '',
      extension: ext,
      isTrashed: raw.isDeleted ?? false,
      isShared: (raw.sharedWith?.length ?? 0) > 0,
      ownerId: (raw.uploadedBy as any)?._id?.toString() ?? id,
    };
  }
}
