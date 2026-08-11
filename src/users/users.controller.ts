import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Patch,
  Delete,
  UseGuards,
  Query,
  Put,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Logger,
  UseInterceptors,
  UploadedFile,
  Res,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { Throttle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';

import { UsersService, AuthUser } from './users.service';
import {
  CreateUserDto,
  UpdateUserDto,
  UpdateProfileDto,
  UpdateNotificationPreferencesDto,
  UpdateWorkspacePreferencesDto,
  ChangePasswordDto,
  UpdateQuotaDto,
  ListUsersDto,
  ReorderUsersDto,
} from './dto/user.dto';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../common/enums';

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  private readonly logger = new Logger(UsersController.name);

  constructor(private readonly usersService: UsersService) {}

  /* ──────────────────────────────────────────────
     STATIC / SELF ROUTES  (before /:id)
  ────────────────────────────────────────────── */

  /** GET /users/me — own profile */
  @Get('me')
  async getMe(@CurrentUser() user: any): Promise<any> {
    const data = await this.usersService.findById(user._id.toString());
    return { success: true, message: 'Profile retrieved successfully', data };
  }

  /** PATCH /users/me — update own profile (name/department/phone/avatar only) */
  @Patch('me')
  async updateMe(@CurrentUser() user: any, @Body() dto: UpdateProfileDto) {
    const data = await this.usersService.updateProfile(user._id.toString(), dto);
    return { success: true, message: 'Profile updated successfully', data };
  }

  /** Upload a profile photo (5 MB) or banner (8 MB). */
  @Patch('me/profile-media/:kind')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }),
  )
  async uploadProfileMedia(
    @CurrentUser() user: any,
    @Param('kind') kind: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const data = await this.usersService.uploadProfileMedia(
      user._id.toString(),
      kind,
      file,
    );
    return { success: true, message: 'Profile image updated successfully', data };
  }

  /** Stream the current user's private profile image from R2. */
  @Get('me/profile-media/:kind')
  async getProfileMedia(
    @CurrentUser() user: any,
    @Param('kind') kind: string,
    @Res() response: Response,
  ): Promise<void> {
    const media = await this.usersService.getProfileMedia(user._id.toString(), kind);
    response.setHeader('Content-Type', media.contentType);
    response.setHeader('Content-Length', String(media.size));
    response.setHeader('Cache-Control', 'private, max-age=300');
    response.setHeader('Content-Disposition', 'inline');
    media.stream.pipe(response);
  }

  /** GET /users/me/notification-preferences */
  @Get('me/notification-preferences')
  async getNotificationPreferences(@CurrentUser() user: any) {
    const data = await this.usersService.getNotificationPreferences(
      user._id.toString(),
    );
    return { success: true, message: 'Notification preferences retrieved', data };
  }

  /** PATCH /users/me/notification-preferences */
  @Patch('me/notification-preferences')
  async updateNotificationPreferences(
    @CurrentUser() user: any,
    @Body() dto: UpdateNotificationPreferencesDto,
  ) {
    const data = await this.usersService.updateNotificationPreferences(
      user._id.toString(),
      dto,
    );
    return { success: true, message: 'Notification preferences updated', data };
  }

  @Get('me/workspace-preferences')
  async getWorkspacePreferences(@CurrentUser() user: any) {
    const data = await this.usersService.getWorkspacePreferences(
      user._id.toString(),
    );
    return { success: true, message: 'Workspace preferences retrieved', data };
  }

  @Patch('me/workspace-preferences')
  async updateWorkspacePreferences(
    @CurrentUser() user: any,
    @Body() dto: UpdateWorkspacePreferencesDto,
  ) {
    const data = await this.usersService.updateWorkspacePreferences(
      user._id.toString(),
      dto,
    );
    return { success: true, message: 'Workspace preferences updated', data };
  }

  /** PUT /users/me/password — change own password */
  @Put('me/password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async changePassword(@CurrentUser() user: any, @Body() dto: ChangePasswordDto) {
    const result = await this.usersService.changePassword(user._id.toString(), dto);
    return { success: true, ...result };
  }

  /** GET /users/me/storage — own storage usage */
  @Get('me/storage')
  async getMyStorage(@CurrentUser() user: any) {
    const data = await this.usersService.getStorageUsage(user._id.toString());
    return { success: true, message: 'Storage usage retrieved', data };
  }

  /** GET /users/admin/stats — aggregate user stats (admin+) */
  @Get('admin/stats')
  @Roles(Role.SUPERADMIN, Role.ADMIN)
  async getAdminStats() {
    const data = await this.usersService.getAdminStats();
    return { success: true, message: 'User stats retrieved', data };
  }

  /* ──────────────────────────────────────────────
     ADMIN — COLLECTION
  ────────────────────────────────────────────── */

  /** POST /users — create user */
  @Post()
  @Roles(Role.SUPERADMIN, Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async create(@Body() dto: CreateUserDto, @CurrentUser() user: any) {
    const created = await this.usersService.create(
      dto,
      user._id.toString(),
      user.role,
    );
    this.logger.log(`User created → ${String(created._id)} by ${user._id}`);
    return { success: true, message: 'User created successfully', data: created };
  }

  /** GET /users — list users (admin+) */
  @Get()
  @Roles(Role.SUPERADMIN, Role.ADMIN)
  async findAll(@CurrentUser() user: any, @Query() query: ListUsersDto): Promise<any> {
    const result = await this.usersService.findAll(
      { _id: user._id.toString(), role: user.role },
      query,
    );
    return { success: true, message: 'Users retrieved successfully', data: result };
  }

  /** PATCH /users/order — persist drag-and-drop ordering for visible users. */
  @Patch('order')
  @Roles(Role.SUPERADMIN, Role.ADMIN)
  async reorder(
    @CurrentUser() user: any,
    @Body() dto: ReorderUsersDto,
  ) {
    const data = await this.usersService.reorderUsers(
      { _id: user._id.toString(), role: user.role },
      dto.userIds,
    );
    return { success: true, message: 'User order updated successfully', data };
  }

  /** GET /users/storage/usage — storage usage for all visible users (admin+) */
  @Get('storage/usage')
  @Roles(Role.SUPERADMIN, Role.ADMIN)
  async getUsersStorageUsage(
    @CurrentUser() user: any,
    @Query() query: ListUsersDto,
  ) {
    const data = await this.usersService.getUsersStorageUsage(
      { _id: user._id.toString(), role: user.role },
      query,
    );
    return { success: true, message: 'Users storage usage retrieved', data };
  }

  /* ──────────────────────────────────────────────
     ADMIN — SINGLE USER
  ────────────────────────────────────────────── */

  /** GET /users/:id */
  @Get(':id')
  @Roles(Role.SUPERADMIN, Role.ADMIN)
  async findOne(@Param('id') id: string): Promise<any> {
    this.requireValidId(id);
    const data = await this.usersService.findById(id);
    return { success: true, message: 'User retrieved successfully', data };
  }

  /** PATCH /users/:id — update any field (admin+) */
  @Patch(':id')
  @Roles(Role.SUPERADMIN, Role.ADMIN)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() user: any,
  ) {
    this.requireValidId(id);

    if (user._id.toString() === id && dto.role) {
      throw new BadRequestException('You cannot change your own role');
    }

    const data = await this.usersService.update(id, dto, {
      _id: user._id.toString(),
      role: user.role,
    });
    this.logger.log(`User updated → ${id} by ${user._id}`);
    return { success: true, message: 'User updated successfully', data };
  }

  /** DELETE /users/:id — hard delete (superadmin only) */
  @Delete(':id')
  @Roles(Role.SUPERADMIN)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async deleteUser(@Param('id') id: string, @CurrentUser() user: any) {
    this.requireValidId(id);

    if (user._id.toString() === id) {
      throw new BadRequestException('You cannot delete yourself');
    }

    await this.usersService.deleteUser(id);
    this.logger.warn(`User deleted → ${id} by ${user._id}`);
    return { success: true, message: 'User deleted successfully' };
  }

  /** GET /users/:id/storage — user's storage (admin+) */
  @Get(':id/storage')
  @Roles(Role.SUPERADMIN, Role.ADMIN)
  async getStorageUsage(@Param('id') id: string) {
    this.requireValidId(id);
    const data = await this.usersService.getStorageUsage(id);
    return { success: true, message: 'Storage usage retrieved', data };
  }

  /** PATCH /users/:id/quota — update storage quota (admin+) */
  @Patch(':id/quota')
  @Roles(Role.SUPERADMIN, Role.ADMIN)
  async updateQuota(@Param('id') id: string, @Body() dto: UpdateQuotaDto) {
    this.requireValidId(id);
    const data = await this.usersService.updateQuota(id, dto.quotaBytes);
    return { success: true, message: 'Storage quota updated successfully', data };
  }

  /** PATCH /users/:id/activate */
  @Patch(':id/activate')
  @Roles(Role.SUPERADMIN, Role.ADMIN)
  async activate(@Param('id') id: string) {
    this.requireValidId(id);
    const result = await this.usersService.activate(id);
    return { success: true, ...result };
  }

  /** PATCH /users/:id/deactivate */
  @Patch(':id/deactivate')
  @Roles(Role.SUPERADMIN, Role.ADMIN)
  async deactivate(@Param('id') id: string, @CurrentUser() user: any) {
    this.requireValidId(id);

    if (user._id.toString() === id) {
      throw new BadRequestException('You cannot deactivate yourself');
    }

    const result = await this.usersService.deactivate(id);
    return { success: true, ...result };
  }

  /** POST /users/:id/sync-storage — force-recalculate storage from files (admin+) */
  @Post(':id/sync-storage')
  @Roles(Role.SUPERADMIN, Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  async syncStorage(@Param('id') id: string) {
    this.requireValidId(id);
    const data = await this.usersService.syncStorageUsed(id);
    return { success: true, message: 'Storage synced successfully', data };
  }

  /* ─── Helpers ─────────────────────────────── */
  private requireValidId(id: string) {
    if (!id || !Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Invalid ID');
    }
  }
}
