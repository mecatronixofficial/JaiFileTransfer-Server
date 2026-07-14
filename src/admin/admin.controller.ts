import {
  Controller,
  Get,
  Query,
  UseGuards,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';

import { AdminService } from './admin.service';
import {
  AdminUsersDto,
  AdminFilesDto,
  AdminTransfersDto,
  AdminLinksDto,
  AdminSessionsDto,
} from './dto/admin.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../common/enums';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.SUPERADMIN)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  /* ============================================================
     DASHBOARD OVERVIEW
     Superadmin: all users, files, shares, transfers, links.
     Admin: scoped to their managed users.
  ============================================================ */
  @Get('overview')
  async getOverview(@CurrentUser() currentUser: any) {
    const data = await this.adminService.getDashboardStats(currentUser);
    return { success: true, message: 'Dashboard overview retrieved successfully', data };
  }

  @Get('dashboard')
  @Roles(Role.SUPERADMIN)
  async getSuperAdminDashboard(@CurrentUser() currentUser: any) {
    const data = await this.adminService.getSuperAdminDashboard(currentUser);
    return { success: true, message: 'Superadmin dashboard retrieved successfully', data };
  }

  /* ============================================================
     STORAGE ANALYTICS
  ============================================================ */
  @Get('storage')
  async getStorageStats(@CurrentUser() currentUser: any) {
    const data = await this.adminService.getStorageStats(currentUser);
    return { success: true, message: 'Storage analytics retrieved successfully', data };
  }

  /* ============================================================
     ACTIVITY FEED — cross-entity recent activity
  ============================================================ */
  @Get('activity')
  async getActivityFeed(
    @CurrentUser() currentUser: any,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    const safeLimit = Math.min(100, Math.max(1, limit));
    const data = await this.adminService.getActivityFeed(currentUser, safeLimit);
    return { success: true, message: 'Activity feed retrieved successfully', data };
  }

  @Get('audit-logs')
  @Roles(Role.SUPERADMIN)
  async getAuditLogs(
    @CurrentUser() currentUser: any,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
  ) {
    const safeLimit = Math.min(200, Math.max(1, limit));
    const data = await this.adminService.getAuditLogs(currentUser, safeLimit);
    return { success: true, message: 'Audit logs retrieved successfully', data };
  }

  /* ============================================================
     USER MANAGEMENT
  ============================================================ */
  @Get('users')
  async getAllUsers(
    @CurrentUser() currentUser: any,
    @Query() dto: AdminUsersDto,
  ) {
    const data = await this.adminService.getAllUsers(currentUser, dto);
    return { success: true, message: 'Users retrieved successfully', data };
  }

  /* ============================================================
     FILE MANAGEMENT
  ============================================================ */
  @Get('files')
  async getAllFiles(
    @CurrentUser() currentUser: any,
    @Query() dto: AdminFilesDto,
  ) {
    const data = await this.adminService.getAllFiles(currentUser, dto);
    return { success: true, message: 'Files retrieved successfully', data };
  }

  /* ============================================================
     SHARE MANAGEMENT — must declare analytics before the list
     so NestJS doesn't try to match "analytics" as a route param
  ============================================================ */
  @Get('shares/analytics')
  async getShareAnalytics(@CurrentUser() currentUser: any) {
    const data = await this.adminService.getShareAnalytics(currentUser);
    return { success: true, message: 'Share analytics retrieved successfully', data };
  }

  @Get('shares')
  async getAllShares(
    @CurrentUser() currentUser: any,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    const data = await this.adminService.getAllShares(currentUser, page, limit);
    return { success: true, message: 'All shares retrieved successfully', data };
  }

  /* ============================================================
     TRANSFER MANAGEMENT
  ============================================================ */
  @Get('transfers')
  async getAllTransfers(
    @CurrentUser() currentUser: any,
    @Query() dto: AdminTransfersDto,
  ) {
    const data = await this.adminService.getAllTransfers(currentUser, dto);
    return { success: true, message: 'Transfers retrieved successfully', data };
  }

  /* ============================================================
     LINK MANAGEMENT
  ============================================================ */
  @Get('links')
  async getAllLinks(
    @CurrentUser() currentUser: any,
    @Query() dto: AdminLinksDto,
  ) {
    const data = await this.adminService.getAllLinks(currentUser, dto);
    return { success: true, message: 'Links retrieved successfully', data };
  }

  /* ============================================================
     UPLOAD SESSION MANAGEMENT
  ============================================================ */
  @Get('upload-sessions')
  async getAllUploadSessions(
    @CurrentUser() currentUser: any,
    @Query() dto: AdminSessionsDto,
  ) {
    const data = await this.adminService.getAllUploadSessions(currentUser, dto);
    return { success: true, message: 'Upload sessions retrieved successfully', data };
  }

  /* ============================================================
     SUPERADMIN ONLY — full system view
  ============================================================ */
  @Get('system')
  @Roles(Role.SUPERADMIN)
  async getSystemStats(@CurrentUser() currentUser: any) {
    const data = await this.adminService.getSystemHealth(currentUser);
    return { success: true, message: 'System health retrieved successfully', data };
  }

  @Get('database')
  @Roles(Role.SUPERADMIN)
  async getDatabaseStats() {
    const data = await this.adminService.getDatabaseStats();
    return { success: true, message: 'Database statistics retrieved successfully', data };
  }
}
