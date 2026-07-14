import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Types } from 'mongoose';

import { NotificationsService } from './notifications.service';
import { BulkMarkReadDto } from './dto/notification.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../common/enums';

@Controller('notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  private currentUserId(user: any): string {
    const userId = user?._id?.toString?.() ?? user?._id ?? user?.id;

    if (!userId || !Types.ObjectId.isValid(userId)) {
      throw new BadRequestException('Invalid authenticated user');
    }

    return userId;
  }

  /* ──────────────────────────────────────────────
     STATIC / ADMIN ROUTES  (must precede /:id)
  ────────────────────────────────────────────── */

  /** GET /notifications/unread-count */
  @Get('unread-count')
  async getUnreadCount(@CurrentUser() user: any) {
    const count = await this.notificationsService.getUnreadCount(
      this.currentUserId(user),
    );
    return { success: true, data: { count } };
  }

  /** PATCH /notifications/read-all */
  @Patch('read-all')
  @HttpCode(HttpStatus.OK)
  async markAllAsRead(@CurrentUser() user: any) {
    const result = await this.notificationsService.markAllAsRead(
      this.currentUserId(user),
    );
    return { success: true, ...result };
  }

  /** PATCH /notifications/bulk-read */
  @Patch('bulk-read')
  @HttpCode(HttpStatus.OK)
  async bulkMarkRead(
    @Body() dto: BulkMarkReadDto,
    @CurrentUser() user: any,
  ) {
    const result = await this.notificationsService.bulkMarkRead(
      dto.ids,
      this.currentUserId(user),
    );
    return { success: true, ...result };
  }

  /** DELETE /notifications/read — delete all read notifications */
  @Delete('read')
  @HttpCode(HttpStatus.OK)
  async deleteAllRead(@CurrentUser() user: any) {
    const result = await this.notificationsService.deleteAllRead(
      this.currentUserId(user),
    );
    return { success: true, ...result };
  }

  /** DELETE /notifications — delete ALL notifications for user */
  @Delete()
  @HttpCode(HttpStatus.OK)
  async deleteAll(@CurrentUser() user: any) {
    const result = await this.notificationsService.deleteAll(
      this.currentUserId(user),
    );
    return { success: true, ...result };
  }

  /** GET /notifications/admin/stats */
  @Get('admin/stats')
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  async getAdminStats() {
    const data = await this.notificationsService.getAdminStats();
    return { success: true, message: 'Notification stats retrieved', data };
  }

  /* ──────────────────────────────────────────────
     MAIN LIST
  ────────────────────────────────────────────── */

  /** GET /notifications */
  @Get()
  async findAll(
    @CurrentUser() user: any,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    const result = await this.notificationsService.findAllForUser(
      this.currentUserId(user),
      page,
      limit,
    );
    return { success: true, message: 'Notifications retrieved successfully', data: result };
  }

  /* ──────────────────────────────────────────────
     PARAMETERISED ROUTES  (must come last)
  ────────────────────────────────────────────── */

  /** PATCH /notifications/:id/read */
  @Patch(':id/read')
  async markAsRead(@Param('id') id: string, @CurrentUser() user: any) {
    if (!Types.ObjectId.isValid(id))
      throw new BadRequestException('Invalid notification ID');

    const result = await this.notificationsService.markAsRead(
      id,
      this.currentUserId(user),
    );
    return { success: true, ...result };
  }

  /** DELETE /notifications/:id */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async deleteOne(@Param('id') id: string, @CurrentUser() user: any) {
    if (!Types.ObjectId.isValid(id))
      throw new BadRequestException('Invalid notification ID');

    const result = await this.notificationsService.delete(
      id,
      this.currentUserId(user),
    );
    return { success: true, ...result };
  }
}
