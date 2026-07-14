import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  Headers,
} from '@nestjs/common';

import { SharesService } from './shares.service';
import {
  CreateShareDto,
  UpdateShareDto,
  ShareQueryDto,
  AccessQueryDto,
  AccessLinkDto,
} from './dto/share.dto';

import { JwtAuthGuard, Public } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ClientIp } from '../common/decorators/client-ip.decorator';
import { Role } from '../common/enums';

@Controller('shares')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SharesController {
  constructor(private readonly sharesService: SharesService) {}

  /* ============================================================
     PUBLIC ENDPOINTS — no JWT required
  ============================================================ */

  /**
   * GET /api/v1/shares/link/:token
   * Anyone with the link can view the shared resource details.
   */
  @Get('link/:token')
  @Public()
  @HttpCode(HttpStatus.OK)
  async accessViaLink(
    @Param('token') token: string,
    @Query('password') queryPassword: string | undefined,
    @Body() dto: AccessLinkDto,
    @ClientIp() ip: string,
    @Headers('user-agent') userAgent: string,
  ): Promise<object> {
    const result = await this.sharesService.accessViaLink(
      token,
      queryPassword ?? dto.password,
      ip,
      userAgent ?? '',
    );

    return {
      success: true,
      message: 'Share accessed successfully',
      data: result,
    };
  }

  /**
   * POST /api/v1/shares/link/:token/download
   * Download all files from the shared resource (file or full folder tree).
   */
  @Post('link/:token/download')
  @Public()
  @HttpCode(HttpStatus.OK)
  async downloadViaLink(
    @Param('token') token: string,
    @Body() dto: AccessLinkDto,
    @ClientIp() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    const result = await this.sharesService.downloadViaLink(
      token,
      dto.password,
      ip,
      userAgent ?? '',
    );

    return {
      success: true,
      message: 'Download URL(s) generated successfully',
      data: result,
    };
  }

  /**
   * GET /api/v1/shares/link/:token/folder/:folderId
   * Browse a subfolder within a shared folder resource.
   */
  @Get('link/:token/folder/:folderId')
  @Public()
  @HttpCode(HttpStatus.OK)
  async accessViaLinkFolder(
    @Param('token') token: string,
    @Param('folderId') folderId: string,
    @Query('password') queryPassword: string | undefined,
    @ClientIp() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    const result = await this.sharesService.accessViaLinkFolder(
      token,
      folderId,
      queryPassword,
      ip,
      userAgent ?? '',
    );

    return {
      success: true,
      message: 'Folder contents retrieved successfully',
      data: result,
    };
  }

  /**
   * GET /api/v1/shares/link/:token/file/:fileId/download
   * Download a single file from a shared resource (file or folder share).
   */
  @Get('link/:token/file/:fileId/download')
  @Public()
  @HttpCode(HttpStatus.OK)
  async downloadViaLinkFile(
    @Param('token') token: string,
    @Param('fileId') fileId: string,
    @Query('password') queryPassword: string | undefined,
    @ClientIp() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    const result = await this.sharesService.downloadViaLinkFile(
      token,
      fileId,
      queryPassword,
      ip,
      userAgent ?? '',
    );

    return {
      success: true,
      message: 'Download URL generated successfully',
      data: result,
    };
  }

  /* ============================================================
     AUTHENTICATED ENDPOINTS
  ============================================================ */

  /**
   * POST /api/v1/shares
   * Create a share (link, email, or private).
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateShareDto,
    @CurrentUser() user: any,
    @ClientIp() ip: string,
  ) {
    const share = await this.sharesService.create(dto, user, ip);

    return {
      success: true,
      message: 'Share created successfully',
      data: share,
    };
  }

  /**
   * GET /api/v1/shares
   * List all shares created by the current user.
   */
  @Get()
  async findMyShares(
    @CurrentUser() user: any,
    @Query() query: ShareQueryDto,
  ) {
    const result = await this.sharesService.findMyShares(user, query);

    return {
      success: true,
      message: 'Shares retrieved successfully',
      data: result,
    };
  }

  /* ============================================================
     ADMIN ENDPOINTS — must be declared before /:id to prevent
     NestJS from matching "admin" as an ID parameter
  ============================================================ */

  /**
   * GET /api/v1/shares/admin/all
   * List ALL shares across all users (paginated, filterable).
   */
  @Get('admin/all')
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  async getAllShares(
    @CurrentUser() user: any,
    @Query() query: ShareQueryDto,
  ) {
    const result = await this.sharesService.getAllShares(user, query);

    return {
      success: true,
      message: 'All shares retrieved successfully',
      data: result,
    };
  }

  /**
   * GET /api/v1/shares/admin/accesses
   * Global access log across all shares.
   */
  @Get('admin/accesses')
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  async getAllAccesses(@Query() query: AccessQueryDto) {
    const result = await this.sharesService.getAllAccesses(query);

    return {
      success: true,
      message: 'All access logs retrieved successfully',
      data: result,
    };
  }

  /**
   * GET /api/v1/shares/admin/analytics
   * Share analytics: views, downloads, top files, device/browser breakdown.
   */
  @Get('admin/analytics')
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  async getAnalytics() {
    const result = await this.sharesService.getShareAnalytics();

    return {
      success: true,
      message: 'Share analytics retrieved successfully',
      data: result,
    };
  }

  /* ============================================================
     PARAMETERISED ENDPOINTS — after all static routes
  ============================================================ */

  /**
   * GET /api/v1/shares/:id
   * Get a specific share with full details and stats.
   */
  @Get(':id')
  async findOne(@Param('id') id: string, @CurrentUser() user: any) {
    const share = await this.sharesService.findById(id, user);

    return {
      success: true,
      message: 'Share retrieved successfully',
      data: share,
    };
  }

  /**
   * GET /api/v1/shares/:id/accesses
   * Get the access log for a specific share (who viewed, downloaded, when, from where).
   */
  @Get(':id/accesses')
  async getAccesses(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Query() query: AccessQueryDto,
  ) {
    const result = await this.sharesService.getAccesses(id, user, query);

    return {
      success: true,
      message: 'Access log retrieved successfully',
      data: result,
    };
  }

  /**
   * PATCH /api/v1/shares/:id
   * Update share settings (permissions, expiry, password, recipients).
   */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateShareDto,
    @CurrentUser() user: any,
    @ClientIp() ip: string,
  ) {
    const share = await this.sharesService.update(id, dto, user, ip);

    return {
      success: true,
      message: 'Share updated successfully',
      data: share,
    };
  }

  /**
   * PATCH /api/v1/shares/:id/revoke
   * Revoke a share link (deactivate, optionally notify recipients).
   */
  @Patch(':id/revoke')
  @HttpCode(HttpStatus.OK)
  async revoke(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @ClientIp() ip: string,
  ) {
    const result = await this.sharesService.revoke(id, user, ip);

    return { success: true, ...result };
  }

  /**
   * DELETE /api/v1/shares/:id
   * Permanently delete a share and its access log.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async delete(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @ClientIp() ip: string,
  ) {
    const result = await this.sharesService.delete(id, user, ip);

    return { success: true, ...result };
  }
}
