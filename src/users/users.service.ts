import {
  Injectable,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import type { Readable } from 'stream';

import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  DEFAULT_WORKSPACE_PREFERENCES,
  NotificationPreferences,
  WorkspacePreferences,
  User,
  UserDocument,
} from './schemas/user.schema';
import { FileRecord, FileDocument } from '../files/schemas/file.schema';
import {
  CreateUserDto,
  UpdateUserDto,
  UpdateProfileDto,
  UpdateNotificationPreferencesDto,
  UpdateWorkspacePreferencesDto,
  ChangePasswordDto,
  ListUsersDto,
} from './dto/user.dto';
import { Role } from '../common/enums';
import { MailService } from '../mail/mail.service';
import { FilesService } from '../files/files.service';
import { R2Service } from '../r2/r2.service';
import {
  RawStorageCategoryStat,
  buildStorageCategoryStats,
  storageCategoryExpression,
} from '../files/storage-category.util';

const SALT_ROUNDS = 12;
const PROFILE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PROFILE_IMAGE_LIMITS = {
  avatar: 5 * 1024 * 1024,
  banner: 8 * 1024 * 1024,
} as const;

export type ProfileMediaKind = keyof typeof PROFILE_IMAGE_LIMITS;

export interface AuthUser {
  _id: string;
  role: Role;
  email?: string;
  name?: string;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(FileRecord.name)
    private readonly fileModel: Model<FileDocument>,
    private readonly mailService: MailService,
    private readonly filesService: FilesService,
    private readonly r2Service: R2Service,
  ) {}

  /* ═══════════════════════════════════════
     CREATE
  ═══════════════════════════════════════ */
  async create(
    dto: CreateUserDto,
    createdById: string,
    creatorRole: Role,
  ): Promise<UserDocument> {
    this.validateId(createdById);

    const email = this.normalizeEmail(dto.email);

    if (dto.role === Role.SUPERADMIN && creatorRole !== Role.SUPERADMIN) {
      throw new ForbiddenException('Only SUPERADMIN can create SUPERADMIN');
    }

    const exists = await this.userModel.exists({ email });
    if (exists) throw new ConflictException('Email already exists');

    const plainPassword = dto.password;
    const hashedPassword = await bcrypt.hash(plainPassword, SALT_ROUNDS);

    let user: UserDocument;
    try {
      user = await this.userModel.create({
        ...dto,
        email,
        password: hashedPassword,
        role: dto.role ?? Role.USER,
        createdBy: new Types.ObjectId(createdById),
        organizationId:
          creatorRole === Role.SUPERADMIN ? null : new Types.ObjectId(createdById),
        tokenVersion: 0,
        isActive: true,
        loginCount: 0,
      });
    } catch (err: unknown) {
      const mongoErr = err as { code?: number; stack?: string };
      if (mongoErr?.code === 11000) throw new ConflictException('Email already exists');
      this.logger.error('Failed to create user', mongoErr?.stack);
      throw err;
    }

    this.mailService
      .sendWelcomeEmail(email, dto.name, plainPassword)
      .catch((err: Error) =>
        this.logger.error(`Welcome email failed for ${email}: ${err.message}`),
      );

    return user;
  }

  /* ═══════════════════════════════════════
     LIST (admin / superadmin)
  ═══════════════════════════════════════ */
  async findAll(user: AuthUser, dto: ListUsersDto = {}): Promise<any> {
    const page = Math.max(1, dto.page ?? 1);
    const limit = Math.min(Math.max(1, dto.limit ?? 20), 100);
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = {};

    if (user.role === Role.ADMIN) {
      query.createdBy = new Types.ObjectId(user._id);
    }
    if (dto.search) {
      const escaped = this.escapeRegex(dto.search);
      query.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { email: { $regex: escaped, $options: 'i' } },
      ];
    }
    if (dto.role) query.role = dto.role;
    if (dto.isActive !== undefined) query.isActive = dto.isActive;

    const [users, total] = await Promise.all([
      this.userModel
        .find(query)
        .select('-password -refreshToken')
        .sort({ sortOrder: 1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.userModel.countDocuments(query).exec(),
    ]);

    const userIds = users.map((item) => item._id);
    const usage = userIds.length
      ? await this.fileModel.aggregate<{
          _id: Types.ObjectId;
          usedBytes: number;
          fileCount: number;
        }>([
          { $match: { uploadedBy: { $in: userIds }, isDeleted: false } },
          {
            $group: {
              _id: '$uploadedBy',
              usedBytes: { $sum: '$size' },
              fileCount: { $sum: 1 },
            },
          },
        ])
      : [];
    const usageByUser = new Map(
      usage.map((item) => [
        item._id.toString(),
        { usedBytes: item.usedBytes, fileCount: item.fileCount },
      ]),
    );

    return {
      users: users.map((item) => {
        const itemUsage = usageByUser.get(item._id.toString()) ?? {
          usedBytes: 0,
          fileCount: 0,
        };

        return {
          ...item,
          storage: this.buildBasicStorageDetails(
            itemUsage.usedBytes,
            item.storageQuota ?? 0,
            itemUsage.fileCount,
          ),
        };
      }),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  async reorderUsers(currentUser: AuthUser, userIds: string[]) {
    const uniqueIds = [...new Set(userIds)];
    if (uniqueIds.length !== userIds.length) {
      throw new BadRequestException('User order contains duplicate IDs');
    }
    uniqueIds.forEach((id) => this.validateId(id));

    const allowedQuery: Record<string, unknown> = {
      _id: { $in: uniqueIds.map((id) => new Types.ObjectId(id)) },
    };
    if (currentUser.role === Role.ADMIN) {
      allowedQuery.createdBy = new Types.ObjectId(currentUser._id);
    }

    const allowedCount = await this.userModel.countDocuments(allowedQuery).exec();
    if (allowedCount !== uniqueIds.length) {
      throw new ForbiddenException('You can only reorder users you are allowed to manage');
    }

    await this.userModel.bulkWrite(
      uniqueIds.map((id, sortOrder) => ({
        updateOne: {
          filter: { _id: new Types.ObjectId(id) },
          update: { $set: { sortOrder } },
        },
      })),
    );

    return { userIds: uniqueIds };
  }

  /* ═══════════════════════════════════════
     GET BY ID
  ═══════════════════════════════════════ */
  async findById(id: string): Promise<any> {
    this.validateId(id);

    const user = await this.userModel
      .findById(id)
      .select('-password -refreshToken')
      .lean()
      .exec();

    if (!user) throw new NotFoundException('User not found');

    const [usage] = await this.fileModel.aggregate<{
      usedBytes: number;
      fileCount: number;
    }>([
      { $match: { uploadedBy: new Types.ObjectId(id), isDeleted: false } },
      {
        $group: {
          _id: null,
          usedBytes: { $sum: '$size' },
          fileCount: { $sum: 1 },
        },
      },
    ]);

    return {
      ...user,
      storage: this.buildBasicStorageDetails(
        usage?.usedBytes ?? 0,
        user.storageQuota ?? 0,
        usage?.fileCount ?? 0,
      ),
    };
  }

  async findByEmail(email: string, includePassword = false): Promise<UserDocument | null> {
    const q = this.userModel.findOne({ email: this.normalizeEmail(email) });
    if (includePassword) q.select('+password +refreshToken');
    return q.exec();
  }

  /* ═══════════════════════════════════════
     AUTH USER (login / JWT)
  ═══════════════════════════════════════ */
  async findAuthUserById(userId: string): Promise<UserDocument> {
    this.validateId(userId);

    const user = await this.userModel
      .findById(userId)
      .select('+password +refreshToken')
      .exec();

    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /* ═══════════════════════════════════════
     UPDATE (admin)
  ═══════════════════════════════════════ */
  async update(
    id: string,
    dto: UpdateUserDto & { email?: string },
    currentUser?: AuthUser,
  ) {
    this.validateId(id);

    const existingUser = await this.userModel.findById(id).lean().exec();
    if (!existingUser) throw new NotFoundException('User not found');

    let normalizedEmail: string | undefined;
    if (dto.email) {
      normalizedEmail = this.normalizeEmail(dto.email);

      if (normalizedEmail === existingUser.email) {
        normalizedEmail = undefined; // no-op, skip the conflict check
      } else {
        const emailExists = await this.userModel.exists({
          email: normalizedEmail,
          _id: { $ne: new Types.ObjectId(id) },
        });
        if (emailExists) throw new ConflictException('Email already in use');
      }
    }

    if (dto.role) {
      if (dto.role === Role.SUPERADMIN) {
        throw new ForbiddenException('Cannot assign SUPERADMIN role');
      }
      if (currentUser && currentUser._id === id) {
        throw new ForbiddenException('You cannot change your own role');
      }
      if (
        currentUser?.role === Role.ADMIN &&
        existingUser.role &&
        [Role.ADMIN, Role.SUPERADMIN].includes(existingUser.role)
      ) {
        throw new ForbiddenException('Insufficient permission');
      }
    }

    const allowedUpdates: Record<string, unknown> = {};
    if (dto.name !== undefined) allowedUpdates.name = dto.name.trim();
    if (normalizedEmail !== undefined) allowedUpdates.email = normalizedEmail;
    if (dto.department !== undefined) allowedUpdates.department = dto.department.trim();
    if (dto.phone !== undefined) allowedUpdates.phone = dto.phone;
    if (dto.role !== undefined) allowedUpdates.role = dto.role;
    if (dto.isActive !== undefined) allowedUpdates.isActive = dto.isActive;

    if (Object.keys(allowedUpdates).length === 0) {
      throw new BadRequestException('No valid fields to update');
    }

    const sensitiveChange =
      allowedUpdates.role !== undefined ||
      allowedUpdates.isActive === false ||
      allowedUpdates.email !== undefined;

    if (sensitiveChange) {
      allowedUpdates.refreshToken = null;
    }

    const updateOps: Record<string, unknown> = { $set: allowedUpdates };
    if (sensitiveChange) updateOps.$inc = { tokenVersion: 1 };

    const user = await this.userModel
      .findByIdAndUpdate(id, updateOps, { new: true, runValidators: true })
      .select('-password -refreshToken')
      .lean()
      .exec();

    /* Notify old email address when email changes */
    if (normalizedEmail && existingUser.email) {
      this.mailService
        .sendEmailChangeNotice(existingUser.email, existingUser.name, normalizedEmail)
        .catch((err: Error) =>
          this.logger.error(`Email change notice failed: ${err.message}`),
        );
    }

    return user;
  }

  /* ═══════════════════════════════════════
     UPDATE PROFILE (self)
  ═══════════════════════════════════════ */
  async updateProfile(userId: string, dto: UpdateProfileDto) {
    this.validateId(userId);

    const allowedUpdates: Record<string, unknown> = {};
    if (dto.name !== undefined) {
      const name = typeof dto.name === 'string' ? dto.name.trim() : '';
      if (!name) throw new BadRequestException('Name is required');
      allowedUpdates.name = name;
    }
    if (dto.department !== undefined) {
      allowedUpdates.department =
        typeof dto.department === 'string' ? dto.department.trim() || null : null;
    }
    if (dto.phone !== undefined) allowedUpdates.phone = dto.phone || null;
    if (dto.avatar !== undefined) allowedUpdates.avatar = dto.avatar || null;

    if (Object.keys(allowedUpdates).length === 0) {
      throw new BadRequestException('No valid fields to update');
    }

    const user = await this.userModel
      .findByIdAndUpdate(userId, { $set: allowedUpdates }, { new: true, runValidators: true })
      .select('-password -refreshToken')
      .lean()
      .exec();

    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async uploadProfileMedia(
    userId: string,
    kind: string,
    file: Express.Multer.File,
  ) {
    this.validateId(userId);
    this.validateProfileImage(kind, file);

    const existing = await this.userModel
      .findById(userId)
      .select('+avatarKey +profileBannerKey')
      .lean<{
        avatarKey?: string | null;
        profileBannerKey?: string | null;
      }>()
      .exec();
    if (!existing) throw new NotFoundException('User not found');

    const extension = file.mimetype === 'image/jpeg'
      ? 'jpg'
      : file.mimetype === 'image/png'
        ? 'png'
        : 'webp';
    const key = `profile-media/${userId}/${kind}-${randomUUID()}.${extension}`;
    const keyField = kind === 'avatar' ? 'avatarKey' : 'profileBannerKey';
    const urlField = kind === 'avatar' ? 'avatar' : 'profileBanner';
    const oldKey = kind === 'avatar' ? existing.avatarKey : existing.profileBannerKey;
    const mediaUrl = `/api/v1/users/me/profile-media/${kind}?v=${Date.now()}`;

    await this.r2Service.uploadObject(key, file.buffer, file.mimetype);

    let user;
    try {
      user = await this.userModel
        .findByIdAndUpdate(
          userId,
          { $set: { [keyField]: key, [urlField]: mediaUrl } },
          { new: true, runValidators: true },
        )
        .select('-password -refreshToken -avatarKey -profileBannerKey')
        .lean()
        .exec();
    } catch (error) {
      await this.r2Service.deleteObject(key).catch(() => undefined);
      throw error;
    }

    if (!user) {
      await this.r2Service.deleteObject(key).catch(() => undefined);
      throw new NotFoundException('User not found');
    }

    if (oldKey && oldKey !== key) {
      await this.r2Service.deleteObject(oldKey).catch((error: Error) => {
        this.logger.warn(`Could not remove previous ${kind}: ${error.message}`);
      });
    }

    return user;
  }

  async getProfileMedia(
    userId: string,
    kind: string,
  ): Promise<{ stream: Readable; contentType: string; size: number }> {
    this.validateId(userId);
    this.validateProfileMediaKind(kind);

    const user = await this.userModel
      .findById(userId)
      .select('+avatarKey +profileBannerKey')
      .lean<{
        avatarKey?: string | null;
        profileBannerKey?: string | null;
      }>()
      .exec();
    if (!user) throw new NotFoundException('User not found');

    const key = kind === 'avatar' ? user.avatarKey : user.profileBannerKey;
    if (!key) throw new NotFoundException(`${kind === 'avatar' ? 'Profile photo' : 'Banner'} not found`);

    const metadata = await this.r2Service.getObjectMetadata(key);
    if (!metadata) throw new NotFoundException('Profile image not found');

    return {
      stream: await this.r2Service.getObjectStream(key),
      contentType: metadata.contentType,
      size: metadata.size,
    };
  }

  private validateProfileMediaKind(kind: string): asserts kind is ProfileMediaKind {
    if (kind !== 'avatar' && kind !== 'banner') {
      throw new BadRequestException('Profile image type must be avatar or banner');
    }
  }

  private validateProfileImage(kind: string, file?: Express.Multer.File): asserts kind is ProfileMediaKind {
    this.validateProfileMediaKind(kind);
    if (!file?.buffer?.length) throw new BadRequestException('No image provided');
    if (!PROFILE_IMAGE_TYPES.has(file.mimetype)) {
      throw new BadRequestException('Use a JPG, PNG, or WebP image');
    }
    if (file.size > PROFILE_IMAGE_LIMITS[kind]) {
      const maxMb = PROFILE_IMAGE_LIMITS[kind] / (1024 * 1024);
      throw new BadRequestException(`${kind === 'avatar' ? 'Profile photo' : 'Banner'} must be ${maxMb} MB or smaller`);
    }

    const buffer = file.buffer;
    const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isWebp = buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    const signatureMatches =
      (file.mimetype === 'image/jpeg' && isJpeg) ||
      (file.mimetype === 'image/png' && isPng) ||
      (file.mimetype === 'image/webp' && isWebp);

    if (!signatureMatches) throw new BadRequestException('The uploaded file is not a valid image');
  }

  async getNotificationPreferences(
    userId: string,
  ): Promise<NotificationPreferences> {
    this.validateId(userId);
    const user = await this.userModel
      .findById(userId)
      .select('notificationPreferences')
      .lean<{ notificationPreferences?: Partial<NotificationPreferences> }>()
      .exec();

    if (!user) throw new NotFoundException('User not found');
    return {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      ...(user.notificationPreferences ?? {}),
    };
  }

  async updateNotificationPreferences(
    userId: string,
    dto: UpdateNotificationPreferencesDto,
  ): Promise<NotificationPreferences> {
    this.validateId(userId);
    const updates = Object.fromEntries(
      Object.entries(dto)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [`notificationPreferences.${key}`, value]),
    );

    if (Object.keys(updates).length === 0) {
      throw new BadRequestException('No notification preferences to update');
    }

    const user = await this.userModel
      .findByIdAndUpdate(userId, { $set: updates }, { new: true, runValidators: true })
      .select('notificationPreferences')
      .lean<{ notificationPreferences?: Partial<NotificationPreferences> }>()
      .exec();

    if (!user) throw new NotFoundException('User not found');
    return {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      ...(user.notificationPreferences ?? {}),
    };
  }

  async setTwoFactorEnabled(userId: string, enabled: boolean) {
    this.validateId(userId);
    const user = await this.userModel
      .findByIdAndUpdate(
        userId,
        { $set: { twoFactorEnabled: enabled } },
        { new: true },
      )
      .select('twoFactorEnabled')
      .lean()
      .exec();

    if (!user) throw new NotFoundException('User not found');
    return { twoFactorEnabled: user.twoFactorEnabled ?? false };
  }

  async getWorkspacePreferences(userId: string): Promise<WorkspacePreferences> {
    this.validateId(userId);
    const user = await this.userModel
      .findById(userId)
      .select('workspacePreferences')
      .lean<{ workspacePreferences?: Partial<WorkspacePreferences> }>()
      .exec();
    if (!user) throw new NotFoundException('User not found');
    return {
      ...DEFAULT_WORKSPACE_PREFERENCES,
      ...(user.workspacePreferences ?? {}),
    };
  }

  async updateWorkspacePreferences(
    userId: string,
    dto: UpdateWorkspacePreferencesDto,
  ): Promise<WorkspacePreferences> {
    this.validateId(userId);
    const updates = Object.fromEntries(
      Object.entries(dto)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [`workspacePreferences.${key}`, value]),
    );
    if (Object.keys(updates).length === 0) {
      throw new BadRequestException('No workspace preferences to update');
    }

    const user = await this.userModel
      .findByIdAndUpdate(userId, { $set: updates }, { new: true, runValidators: true })
      .select('workspacePreferences')
      .lean<{ workspacePreferences?: Partial<WorkspacePreferences> }>()
      .exec();
    if (!user) throw new NotFoundException('User not found');
    return {
      ...DEFAULT_WORKSPACE_PREFERENCES,
      ...(user.workspacePreferences ?? {}),
    };
  }

  async deleteOwnAccount(userId: string) {
    this.validateId(userId);
    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new NotFoundException('User not found');
    if (user.role === Role.SUPERADMIN) {
      throw new ForbiddenException('The superadmin account cannot be self-deleted');
    }

    const deletedFiles = await this.filesService.permanentlyDeleteAllForUser(userId);
    await this.userModel.findByIdAndDelete(userId).exec();
    this.logger.warn(`User self-deleted → ${user.email} (${userId})`);
    return { message: 'Account permanently deleted', deletedFiles };
  }

  /* ═══════════════════════════════════════
     CHANGE PASSWORD (self)
  ═══════════════════════════════════════ */
  async changePassword(userId: string, dto: ChangePasswordDto) {
    this.validateId(userId);

    const user = await this.userModel.findById(userId).select('+password').exec();
    if (!user) throw new NotFoundException('User not found');

    const isMatch = await bcrypt.compare(dto.currentPassword, user.password);
    if (!isMatch) throw new BadRequestException('Current password incorrect');

    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('New password must be different from current');
    }

    user.password = await bcrypt.hash(dto.newPassword, SALT_ROUNDS);
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    user.refreshToken = null;
    await user.save();

    this.mailService
      .sendPasswordResetConfirmedEmail(user.email, user.name)
      .catch((err: Error) =>
        this.logger.error(`Password change email failed: ${err.message}`),
      );

    return { message: 'Password changed successfully' };
  }

  /* ═══════════════════════════════════════
     ACTIVATE / DEACTIVATE
  ═══════════════════════════════════════ */
  async toggleActive(userId: string, isActive: boolean) {
    this.validateId(userId);

    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new NotFoundException('User not found');

    if (user.isActive === isActive) {
      return { message: `User already ${isActive ? 'active' : 'inactive'}` };
    }

    user.isActive = isActive;
    if (!isActive) {
      user.tokenVersion = (user.tokenVersion ?? 0) + 1;
      user.refreshToken = null;
    }
    await user.save();

    return { message: `User ${isActive ? 'activated' : 'deactivated'}` };
  }

  deactivate(id: string) { return this.toggleActive(id, false); }
  activate(id: string)   { return this.toggleActive(id, true); }

  /* ═══════════════════════════════════════
     HARD DELETE
  ═══════════════════════════════════════ */
  async deleteUser(id: string) {
    this.validateId(id);

    const user = await this.userModel.findById(id).exec();
    if (!user) throw new NotFoundException('User not found');
    if (user.role === Role.SUPERADMIN) throw new ForbiddenException('Cannot delete SUPERADMIN');

    await this.userModel.findByIdAndDelete(id).exec();
    this.logger.warn(`User deleted → ${user.email} (${id})`);

    return { message: 'User permanently deleted' };
  }

  /* ═══════════════════════════════════════
     STORAGE USAGE — read
  ═══════════════════════════════════════ */
  async getStorageUsage(userId: string) {
    this.validateId(userId);

    const user = await this.userModel.findById(userId).lean().exec();
    if (!user) throw new NotFoundException('User not found');

    const [storage] = await this.fileModel.aggregate<{
      activeSummary: { totalBytes: number; fileCount: number }[];
      trashedSummary: { totalBytes: number; fileCount: number }[];
      byCategory: RawStorageCategoryStat[];
    }>([
      { $match: { uploadedBy: new Types.ObjectId(userId) } },
      {
        $facet: {
          activeSummary: [
            { $match: { isDeleted: false } },
            {
              $group: {
                _id: null,
                totalBytes: { $sum: '$size' },
                fileCount: { $sum: 1 },
              },
            },
          ],
          trashedSummary: [
            { $match: { isDeleted: true } },
            {
              $group: {
                _id: null,
                totalBytes: { $sum: '$size' },
                fileCount: { $sum: 1 },
              },
            },
          ],
          byCategory: [
            { $match: { isDeleted: false } },
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
          ],
        },
      },
    ]);

    const active = storage?.activeSummary[0] ?? { totalBytes: 0, fileCount: 0 };
    const trashed = storage?.trashedSummary[0] ?? { totalBytes: 0, fileCount: 0 };
    const usedBytes = active.totalBytes;
    const quotaBytes = user.storageQuota ?? 0;
    const remainingBytes = Math.max(quotaBytes - usedBytes, 0);

    return {
      usedBytes,
      quotaBytes,
      remainingBytes,
      fileCount: active.fileCount,
      usedGB: +(usedBytes / 1024 ** 3).toFixed(2),
      usedMB: +(usedBytes / 1024 ** 2).toFixed(2),
      quotaGB: +(quotaBytes / 1024 ** 3).toFixed(2),
      quotaMB: +(quotaBytes / 1024 ** 2).toFixed(2),
      remainingGB: +(remainingBytes / 1024 ** 3).toFixed(2),
      usagePercent: quotaBytes > 0 ? +((usedBytes / quotaBytes) * 100).toFixed(2) : 0,
      byCategory: buildStorageCategoryStats(storage?.byCategory ?? [], usedBytes),
      trashed: {
        usedBytes: trashed.totalBytes,
        fileCount: trashed.fileCount,
        usedMB: +(trashed.totalBytes / 1024 ** 2).toFixed(2),
        usedGB: +(trashed.totalBytes / 1024 ** 3).toFixed(4),
      },
    };
  }

  async getUsersStorageUsage(currentUser: AuthUser, dto: ListUsersDto = {}) {
    type UserStorageRollup = {
      _id: Types.ObjectId;
      usedBytes: number;
      fileCount: number;
    };

    const page = Math.max(1, dto.page ?? 1);
    const limit = Math.min(Math.max(1, dto.limit ?? 20), 100);
    const skip = (page - 1) * limit;

    const userFilter: Record<string, unknown> = {};

    if (currentUser.role === Role.ADMIN) {
      userFilter.createdBy = new Types.ObjectId(currentUser._id);
    }
    if (dto.search) {
      const escaped = this.escapeRegex(dto.search);
      userFilter.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { email: { $regex: escaped, $options: 'i' } },
      ];
    }
    if (dto.role) userFilter.role = dto.role;
    if (dto.isActive !== undefined) userFilter.isActive = dto.isActive;

    const [users, totalUsers, allUsersForTotals] = await Promise.all([
      this.userModel
        .find(userFilter)
        .select('name email role department isActive storageQuota storageUsed')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.userModel.countDocuments(userFilter).exec(),
      this.userModel.find(userFilter).select('_id storageQuota').lean().exec(),
    ]);

    const visibleUserIds = allUsersForTotals.map((user) => user._id);
    const pageUserIds = users.map((user) => user._id);

    const [allUsage, pageUsage] = await Promise.all([
      visibleUserIds.length
        ? this.fileModel.aggregate<UserStorageRollup>([
            {
              $match: {
                uploadedBy: { $in: visibleUserIds },
                isDeleted: false,
              },
            },
            {
              $group: {
                _id: '$uploadedBy',
                usedBytes: { $sum: '$size' },
                fileCount: { $sum: 1 },
              },
            },
          ])
        : Promise.resolve<UserStorageRollup[]>([]),
      pageUserIds.length
        ? this.fileModel.aggregate<UserStorageRollup>([
            {
              $match: {
                uploadedBy: { $in: pageUserIds },
                isDeleted: false,
              },
            },
            {
              $group: {
                _id: '$uploadedBy',
                usedBytes: { $sum: '$size' },
                fileCount: { $sum: 1 },
              },
            },
          ])
        : Promise.resolve<UserStorageRollup[]>([]),
    ]);

    const usageByUser = new Map(
      pageUsage.map((item) => [
        item._id.toString(),
        { usedBytes: item.usedBytes, fileCount: item.fileCount },
      ]),
    );

    const usersStorage = users.map((user) => {
      const usage = usageByUser.get(user._id.toString()) ?? {
        usedBytes: 0,
        fileCount: 0,
      };
      const quotaBytes = user.storageQuota ?? 0;
      const remainingBytes = Math.max(quotaBytes - usage.usedBytes, 0);

      return {
        userId: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department ?? null,
        isActive: user.isActive,
        usedBytes: usage.usedBytes,
        quotaBytes,
        remainingBytes,
        fileCount: usage.fileCount,
        usedMB: +(usage.usedBytes / 1024 ** 2).toFixed(2),
        usedGB: +(usage.usedBytes / 1024 ** 3).toFixed(4),
        quotaGB: +(quotaBytes / 1024 ** 3).toFixed(2),
        remainingGB: +(remainingBytes / 1024 ** 3).toFixed(2),
        usagePercent:
          quotaBytes > 0 ? +((usage.usedBytes / quotaBytes) * 100).toFixed(2) : 0,
      };
    });

    const totalUsedBytes = allUsage.reduce((sum, item) => sum + item.usedBytes, 0);
    const totalFileCount = allUsage.reduce((sum, item) => sum + item.fileCount, 0);
    const totalQuotaBytes = allUsersForTotals.reduce(
      (sum, user) => sum + (user.storageQuota ?? 0),
      0,
    );

    return {
      summary: {
        totalUsers,
        totalUsedBytes,
        totalQuotaBytes,
        totalRemainingBytes: Math.max(totalQuotaBytes - totalUsedBytes, 0),
        totalFileCount,
        totalUsedMB: +(totalUsedBytes / 1024 ** 2).toFixed(2),
        totalUsedGB: +(totalUsedBytes / 1024 ** 3).toFixed(4),
        totalQuotaGB: +(totalQuotaBytes / 1024 ** 3).toFixed(2),
        usagePercent:
          totalQuotaBytes > 0
            ? +((totalUsedBytes / totalQuotaBytes) * 100).toFixed(2)
            : 0,
      },
      users: usersStorage,
      pagination: { page, limit, total: totalUsers, pages: Math.ceil(totalUsers / limit) },
    };
  }

  /* ═══════════════════════════════════════
     STORAGE USED — update counter atomically
     delta > 0 = add (upload), delta < 0 = subtract (delete)
  ═══════════════════════════════════════ */
  async updateStorageUsed(userId: string, deltaBytes: number) {
    if (deltaBytes === 0) return;
    this.validateId(userId);
    await this.userModel.findByIdAndUpdate(userId, {
      $inc: { storageUsed: deltaBytes },
    });
  }

  /* ═══════════════════════════════════════
     SYNC STORAGE — recalculate from files
  ═══════════════════════════════════════ */
  async syncStorageUsed(userId: string) {
    this.validateId(userId);

    const agg = await this.fileModel.aggregate([
      { $match: { uploadedBy: new Types.ObjectId(userId), isDeleted: false } },
      { $group: { _id: null, total: { $sum: '$size' } } },
    ]);
    const realUsed: number = agg[0]?.total ?? 0;

    await this.userModel.findByIdAndUpdate(userId, { storageUsed: realUsed });
    return { userId, storageUsed: realUsed };
  }

  /* ═══════════════════════════════════════
     ADMIN STATS
  ═══════════════════════════════════════ */
  async getAdminStats() {
    const [total, active, inactive, byRole, storageResult] = await Promise.all([
      this.userModel.countDocuments(),
      this.userModel.countDocuments({ isActive: true }),
      this.userModel.countDocuments({ isActive: false }),
      this.userModel.aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$role', count: { $sum: 1 } } },
      ]),
      this.userModel.aggregate<{ totalUsed: number; totalQuota: number }>([
        {
          $group: {
            _id: null,
            totalUsed: { $sum: '$storageUsed' },
            totalQuota: { $sum: '$storageQuota' },
          },
        },
      ]),
    ]);

    return {
      total,
      active,
      inactive,
      byRole: Object.fromEntries(byRole.map((r) => [r._id, r.count])),
      storage: {
        totalUsedBytes: storageResult[0]?.totalUsed ?? 0,
        totalQuotaBytes: storageResult[0]?.totalQuota ?? 0,
      },
    };
  }

  /* ═══════════════════════════════════════
     UPDATE QUOTA (admin)
  ═══════════════════════════════════════ */
  async updateQuota(userId: string, quotaBytes: number) {
    this.validateId(userId);

    if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) {
      throw new BadRequestException('Invalid quota value');
    }

    const updated = await this.userModel
      .findByIdAndUpdate(userId, { storageQuota: quotaBytes }, { new: true })
      .exec();

    if (!updated) throw new NotFoundException('User not found');

    return {
      userId,
      quotaBytes,
      quotaGB: +(quotaBytes / 1024 ** 3).toFixed(2),
    };
  }

  /* ═══════════════════════════════════════
     TOKEN VERSION
  ═══════════════════════════════════════ */
  async incrementTokenVersion(userId: string) {
    this.validateId(userId);
    await this.userModel.findByIdAndUpdate(userId, { $inc: { tokenVersion: 1 } });
  }

  /* ═══════════════════════════════════════
     AUTH HELPERS
  ═══════════════════════════════════════ */
  async updateLastLogin(userId: string, meta?: { ip?: string; userAgent?: string }) {
    this.validateId(userId);
    await this.userModel.findByIdAndUpdate(userId, {
      $set: {
        lastLoginAt: new Date(),
        ...(meta?.ip && { lastIp: meta.ip }),
        ...(meta?.userAgent && { lastUserAgent: meta.userAgent }),
      },
      $inc: { loginCount: 1 },
    });
  }

  /** @deprecated Use updateLastLogin instead */
  async updateLastSeen(userId: string, meta?: { ip?: string; userAgent?: string }) {
    return this.updateLastLogin(userId, meta);
  }

  async validatePassword(
    user: Pick<UserDocument, 'password'> | null | undefined,
    password: string,
  ): Promise<boolean> {
    if (!user?.password) return false;
    return bcrypt.compare(password, user.password);
  }

  async forceSetPassword(userId: string, password: string) {
    this.validateId(userId);
    const hashed = await bcrypt.hash(password, SALT_ROUNDS);
    await this.userModel.findByIdAndUpdate(userId, {
      $set: { password: hashed, refreshToken: null },
      $inc: { tokenVersion: 1 },
    });
  }

  async setRefreshToken(userId: string, token: string) {
    this.validateId(userId);
    const hashed = await bcrypt.hash(token, SALT_ROUNDS);
    await this.userModel.findByIdAndUpdate(userId, { refreshToken: hashed });
  }

  async removeRefreshToken(userId: string) {
    this.validateId(userId);
    await this.userModel.findByIdAndUpdate(userId, { refreshToken: null });
  }

  async compareRefreshToken(userId: string, token: string): Promise<boolean> {
    this.validateId(userId);
    const user = await this.userModel
      .findById(userId)
      .select('+refreshToken')
      .lean()
      .exec();
    if (!user?.refreshToken) return false;
    return bcrypt.compare(token, user.refreshToken);
  }

  /* ═══════════════════════════════════════
     HELPERS
  ═══════════════════════════════════════ */
  private validateId(id: string) {
    if (!id || !Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Invalid ID');
    }
  }

  private normalizeEmail(email: string) {
    return email.toLowerCase().trim();
  }

  private escapeRegex(input: string) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private buildBasicStorageDetails(
    usedBytes: number,
    quotaBytes: number,
    fileCount = 0,
  ) {
    const remainingBytes = Math.max(quotaBytes - usedBytes, 0);

    return {
      usedBytes,
      quotaBytes,
      remainingBytes,
      fileCount,
      usedMB: +(usedBytes / 1024 ** 2).toFixed(2),
      usedGB: +(usedBytes / 1024 ** 3).toFixed(4),
      quotaGB: +(quotaBytes / 1024 ** 3).toFixed(2),
      remainingGB: +(remainingBytes / 1024 ** 3).toFixed(2),
      usagePercent: quotaBytes > 0 ? +((usedBytes / quotaBytes) * 100).toFixed(2) : 0,
    };
  }
}
