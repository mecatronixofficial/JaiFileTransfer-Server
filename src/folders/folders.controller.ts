import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Patch,
  UseGuards,
  HttpCode,
  HttpStatus,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { Types } from 'mongoose';

import { FoldersService } from './folders.service';
import { FilesService } from '../files/files.service';
import {
  CreateFolderDto,
  UpdateFolderDto,
  MoveFolderDto,
  ListFoldersDto,
} from './dto/folder.dto';
import { FileQueryDto } from '../files/dto/file.dto';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../common/enums';

@Controller('folders')
@UseGuards(JwtAuthGuard, RolesGuard)
export class FoldersController {
  constructor(
    private readonly foldersService: FoldersService,
    private readonly filesService: FilesService,
  ) {}

  /* ──────────────────────────────────────────────
     STATIC ROUTES  (must precede /:id)
  ────────────────────────────────────────────── */

  /** GET /folders/trash — list user's trashed folders */
  @Get('trash')
  async getTrashed(@CurrentUser() user: any) {
    const data = await this.foldersService.getTrashed(user);
    return { success: true, message: 'Trashed folders retrieved', data };
  }

  /** GET /folders/admin/stats */
  @Get('admin/stats')
  @Roles(Role.SUPERADMIN)
  async getAdminStats() {
    const data = await this.foldersService.getAdminStats();
    return { success: true, message: 'Folder stats retrieved', data };
  }

  /* ──────────────────────────────────────────────
     COLLECTION
  ────────────────────────────────────────────── */

  /** POST /folders */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateFolderDto, @CurrentUser() user: any) {
    const data = await this.foldersService.create(dto, user);
    return { success: true, message: 'Folder created successfully', data };
  }

  /** GET /folders — paginated flat list; supports parentId, search */
  @Get()
  async findAll(@CurrentUser() user: any, @Query() query: ListFoldersDto) {
    const data = await this.foldersService.findAll(user, query);
    return { success: true, message: 'Folders retrieved successfully', data };
  }

  /** GET /folders/tree — nested tree */
  @Get('tree')
  async getTree(@CurrentUser() user: any) {
    const data = await this.foldersService.getFolderTree(user);
    return { success: true, message: 'Folder tree retrieved successfully', data };
  }

  /* ──────────────────────────────────────────────
     SINGLE FOLDER  (parameterised — must come last)
  ────────────────────────────────────────────── */

  /** GET /folders/:id */
  @Get(':id')
  async findOne(@Param('id') id: string, @CurrentUser() user: any) {
    this.requireValidId(id);
    const data = await this.foldersService.findOne(id, user);
    return { success: true, message: 'Folder retrieved successfully', data };
  }

  /** GET /folders/:id/contents — subfolders + files + breadcrumb */
  @Get(':id/contents')
  async getContents(@Param('id') id: string, @CurrentUser() user: any) {
    this.requireValidId(id);
    const data = await this.foldersService.getContents(id, user);
    return { success: true, message: 'Folder contents retrieved successfully', data };
  }

  /** GET /folders/:id/files — paginated files in folder */
  @Get(':id/files')
  async getFolderFiles(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Query() query: FileQueryDto,
  ) {
    this.requireValidId(id);
    await this.foldersService.findOne(id, user);
    const data = await this.filesService.findAll(user, { ...query, folderId: id });
    return { success: true, message: 'Folder files retrieved successfully', data };
  }

  /** PATCH /folders/:id — rename / update description / color */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateFolderDto,
    @CurrentUser() user: any,
  ) {
    this.requireValidId(id);
    const data = await this.foldersService.update(id, dto, user);
    return { success: true, message: 'Folder updated successfully', data };
  }

  /** PATCH /folders/:id/move */
  @Patch(':id/move')
  async moveFolder(
    @Param('id') id: string,
    @Body() dto: MoveFolderDto,
    @CurrentUser() user: any,
  ) {
    this.requireValidId(id);
    const data = await this.foldersService.moveFolder(id, dto.parentId ?? null, user);
    return { success: true, message: 'Folder moved successfully', data };
  }

  /** PATCH /folders/:id/restore */
  @Patch(':id/restore')
  @HttpCode(HttpStatus.OK)
  async restore(@Param('id') id: string, @CurrentUser() user: any) {
    this.requireValidId(id);
    const result = await this.foldersService.restore(id, user);
    return { success: true, ...result };
  }

  /** DELETE /folders/:id — soft delete (trash) */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async softDelete(@Param('id') id: string, @CurrentUser() user: any) {
    this.requireValidId(id);
    const result = await this.foldersService.softDelete(id, user);
    return { success: true, ...result };
  }

  /** DELETE /folders/:id/permanent — hard delete, owner or superadmin */
  @Delete(':id/permanent')
  @HttpCode(HttpStatus.OK)
  async hardDelete(@Param('id') id: string, @CurrentUser() user: any) {
    this.requireValidId(id);
    const result = await this.foldersService.hardDelete(id, user);
    return { success: true, ...result };
  }

  /* ─── Helper ──────────────────────────────── */
  private requireValidId(id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Invalid folder ID');
    }
  }
}
