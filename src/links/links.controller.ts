import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  Body,
  Headers,
} from '@nestjs/common';

import { LinksService } from './links.service';
import { JwtAuthGuard, Public } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ClientIp } from '../common/decorators/client-ip.decorator';
import { Role } from '../common/enums';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

class RenewDto {
  @IsInt()
  @Min(1)
  @Max(365)
  @IsOptional()
  @Type(() => Number)
  days?: number;
}

class CreateLinkDto {
  @IsIn(['file', 'folder'])
  resourceType: 'file' | 'folder';

  @IsMongoId()
  resourceId: string;

  @IsIn(['link', 'qr', 'email'])
  @IsOptional()
  method?: 'link' | 'qr' | 'email';

  @IsIn(['view', 'download'])
  @IsOptional()
  permission?: 'view' | 'download';

  @IsIn(['public', 'private', 'specific'])
  @IsOptional()
  privacy?: 'public' | 'private' | 'specific';

  @IsInt()
  @Min(1)
  @Max(365)
  @IsOptional()
  @Type(() => Number)
  expiresIn?: number;

  @IsString()
  @MaxLength(120)
  @IsOptional()
  password?: string;

  @IsArray()
  @IsEmail({}, { each: true })
  @ArrayMaxSize(50)
  @IsOptional()
  recipients?: string[];
}

@Controller('links')
@UseGuards(JwtAuthGuard)
export class LinksController {
  constructor(private readonly linksService: LinksService) {}

  /* ═══════════════════════════════════════════════════════
     PUBLIC (unauthenticated) — /links/l/:shortCode
  ═══════════════════════════════════════════════════════ */

  /** View a link — returns metadata + folder/file tree for share links */
  @Public()
  @Get('l/:shortCode')
  async publicView(
    @Param('shortCode') shortCode: string,
    @Query('password') password: string | undefined,
    @ClientIp() ip: string,
    @Headers('user-agent') userAgent: string,
    @Headers('cf-ipcountry') country: string,
  ) {
    const data = await this.linksService.publicView(shortCode, password, {
      ip,
      userAgent: userAgent ?? '',
      location: country ?? null,
    });
    return { success: true, message: 'Link retrieved', data };
  }

  /**
   * Browse a folder within a share-type link.
   * Only folders reachable from the link's root folderIds are accessible.
   */
  @Public()
  @Get('l/:shortCode/folder/:folderId')
  async publicFolderContents(
    @Param('shortCode') shortCode: string,
    @Param('folderId') folderId: string,
    @Query('password') password: string | undefined,
    @ClientIp() ip: string,
    @Headers('user-agent') userAgent: string,
    @Headers('cf-ipcountry') country: string,
  ) {
    const data = await this.linksService.publicFolderContents(
      shortCode,
      folderId,
      password,
      { ip, userAgent: userAgent ?? '', location: country ?? null },
    );
    return { success: true, message: 'Folder contents retrieved', data };
  }

  /**
   * Generate a presigned download URL for a file within a link.
   * Requires the link to have `permission: 'download'`.
   */
  @Public()
  @Get('l/:shortCode/file/:fileId/download')
  async publicFileDownload(
    @Param('shortCode') shortCode: string,
    @Param('fileId') fileId: string,
    @Query('password') password: string | undefined,
    @ClientIp() ip: string,
    @Headers('user-agent') userAgent: string,
    @Headers('cf-ipcountry') country: string,
  ) {
    const data = await this.linksService.publicFileDownload(
      shortCode,
      fileId,
      password,
      { ip, userAgent: userAgent ?? '', location: country ?? null },
    );
    return { success: true, message: 'Download URL generated', data };
  }

  /* ═══════════════════════════════════════
     USER — own links only
  ═══════════════════════════════════════ */

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateLinkDto, @CurrentUser() user: any) {
    const data = await this.linksService.createShareLink(dto, user);
    return { success: true, message: 'Link created', data };
  }

  @Get()
  async findAll(
    @Query() query: { status?: string; method?: string; page?: string; limit?: string },
    @CurrentUser() user: any,
  ) {
    const data = await this.linksService.findAll(String(user._id), {
      status: query.status,
      method: query.method,
      page: query.page ? parseInt(query.page, 10) : undefined,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
    });
    return { success: true, message: 'Links retrieved', data };
  }

  @Get('stats')
  async getStats(@CurrentUser() user: any) {
    const data = await this.linksService.getStats(String(user._id));
    return { success: true, message: 'Link stats retrieved', data };
  }

  @Patch(':id/disable')
  @HttpCode(HttpStatus.OK)
  async disable(@Param('id') id: string, @CurrentUser() user: any) {
    await this.linksService.disable(id, String(user._id));
    return { success: true, message: 'Link disabled' };
  }

  @Patch(':id/enable')
  @HttpCode(HttpStatus.OK)
  async enable(@Param('id') id: string, @CurrentUser() user: any) {
    await this.linksService.enable(id, String(user._id));
    return { success: true, message: 'Link enabled' };
  }

  @Patch(':id/renew')
  @HttpCode(HttpStatus.OK)
  async renew(
    @Param('id') id: string,
    @Body() dto: RenewDto,
    @CurrentUser() user: any,
  ) {
    const result = await this.linksService.renew(id, String(user._id), dto.days);
    return { success: true, message: 'Link renewed', data: result };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async delete(@Param('id') id: string, @CurrentUser() user: any) {
    await this.linksService.delete(id, String(user._id));
    return { success: true, message: 'Link deleted' };
  }

  @Get(':id/accesses')
  async accesses(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Query() query: { page?: string; limit?: string },
  ) {
    const data = await this.linksService.getAccesses(id, user, {
      page: query.page ? parseInt(query.page, 10) : undefined,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
    });
    return { success: true, message: 'Link accesses retrieved', data };
  }

  /* ═══════════════════════════════════════
     ADMIN — all users' links, no ownership check
  ═══════════════════════════════════════ */

  @Get('admin/all')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  async adminFindAll(
    @Query() query: { status?: string; method?: string; page?: string; limit?: string },
  ) {
    const data = await this.linksService.findAllAdmin({
      status: query.status,
      method: query.method,
      page: query.page ? parseInt(query.page, 10) : undefined,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
    });
    return { success: true, message: 'All links retrieved', data };
  }

  @Get('admin/stats')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  async adminGetStats() {
    const data = await this.linksService.getStatsAdmin();
    return { success: true, message: 'Link stats retrieved', data };
  }

  @Patch('admin/:id/disable')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @HttpCode(HttpStatus.OK)
  async adminDisable(@Param('id') id: string) {
    await this.linksService.adminDisable(id);
    return { success: true, message: 'Link disabled' };
  }

  @Patch('admin/:id/enable')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @HttpCode(HttpStatus.OK)
  async adminEnable(@Param('id') id: string) {
    await this.linksService.adminEnable(id);
    return { success: true, message: 'Link enabled' };
  }

  @Patch('admin/:id/renew')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @HttpCode(HttpStatus.OK)
  async adminRenew(@Param('id') id: string, @Body() dto: RenewDto) {
    const result = await this.linksService.adminRenew(id, dto.days);
    return { success: true, message: 'Link renewed', data: result };
  }

  @Delete('admin/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  @HttpCode(HttpStatus.OK)
  async adminDelete(@Param('id') id: string) {
    await this.linksService.adminDelete(id);
    return { success: true, message: 'Link deleted' };
  }
}
