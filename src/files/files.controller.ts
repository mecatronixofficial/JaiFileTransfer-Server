import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  UseGuards,
  Query,
  HttpCode,
  HttpStatus,
  Patch,
  BadRequestException,
} from '@nestjs/common';
import { Types } from 'mongoose';

import { FilesService } from './files.service';
import {
  SaveFileMetadataDto,
  FileQueryDto,
  RenameFileDto,
  UpdateFileDto,
  BulkDeleteDto,
  BulkRestoreDto,
  BulkMoveDto,
} from './dto/file.dto';
import { BatchSaveMetadataDto } from '../upload/dto/upload.dto';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../common/enums';

@Controller('files')
@UseGuards(JwtAuthGuard, RolesGuard)
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  /* ──────────────────────────────────────────────
     STATIC ROUTES  (must precede /:id)
  ────────────────────────────────────────────── */

  /** GET /files/trash */
  @Get('trash')
  async getTrash(@CurrentUser() user: any) {
    const files = await this.filesService.getTrash(user);
    return { success: true, message: 'Trash retrieved successfully', data: files };
  }

  /** GET /files/shared-with-me */
  @Get('shared-with-me')
  async getSharedWithMe(@CurrentUser() user: any) {
    const files = await this.filesService.getSharedWithMe(user);
    return { success: true, message: 'Shared files retrieved', data: files };
  }

  /** GET /files/admin/stats */
  @Get('admin/stats')
  @Roles(Role.SUPERADMIN)
  async getAdminStats() {
    const data = await this.filesService.getAdminStats();
    return { success: true, message: 'File stats retrieved', data };
  }

  /* ──────────────────────────────────────────────
     COLLECTION
  ────────────────────────────────────────────── */

  /** POST /files — save metadata after presigned upload */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async saveMetadata(@Body() dto: SaveFileMetadataDto, @CurrentUser() user: any) {
    const file = await this.filesService.saveMetadata(
      dto,
      user._id.toString(),
      user.organizationId?.toString?.() ?? null,
    );
    return { success: true, message: 'File metadata saved successfully', data: file };
  }

  /** POST /files/batch — save metadata for folder upload */
  @Post('batch')
  @HttpCode(HttpStatus.CREATED)
  async saveBatch(@Body() dto: BatchSaveMetadataDto, @CurrentUser() user: any) {
    const files = await this.filesService.saveBatchMetadata(
      dto.files,
      user._id.toString(),
      user.organizationId?.toString?.() ?? null,
    );
    return { success: true, message: `${files.length} file(s) saved successfully`, data: files };
  }

  /** POST /files/bulk-delete */
  @Post('bulk-delete')
  @HttpCode(HttpStatus.OK)
  async bulkDelete(@Body() dto: BulkDeleteDto, @CurrentUser() user: any) {
    if (!dto.fileIds?.length) throw new BadRequestException('No files provided');
    const result = await this.filesService.bulkDelete(dto, user);
    return { success: true, ...result };
  }

  /** POST /files/bulk-restore */
  @Post('bulk-restore')
  @HttpCode(HttpStatus.OK)
  async bulkRestore(@Body() dto: BulkRestoreDto, @CurrentUser() user: any) {
    const result = await this.filesService.bulkRestore(dto, user);
    return { success: true, ...result };
  }

  /** POST /files/bulk-move */
  @Post('bulk-move')
  @HttpCode(HttpStatus.OK)
  async bulkMove(@Body() dto: BulkMoveDto, @CurrentUser() user: any) {
    const result = await this.filesService.bulkMove(dto, user);
    return { success: true, ...result };
  }

  /** GET /files */
  @Get()
  async findAll(@CurrentUser() user: any, @Query() query: FileQueryDto) {
    const result = await this.filesService.findAll(user, query);
    return { success: true, message: 'Files retrieved successfully', data: result };
  }

  /* ──────────────────────────────────────────────
     SINGLE FILE  (parameterised — must come last)
  ────────────────────────────────────────────── */

  /** GET /files/:id */
  @Get(':id')
  async findOne(@Param('id') id: string, @CurrentUser() user: any) {
    this.requireValidId(id);
    const file = await this.filesService.findOne(id, user);
    return { success: true, message: 'File retrieved successfully', data: file };
  }

  /** GET /files/:id/download */
  @Get(':id/download')
  async download(@Param('id') id: string, @CurrentUser() user: any) {
    this.requireValidId(id);
    const result = await this.filesService.findOneWithDownloadUrl(id, user);
    return {
      success: true,
      message: 'Download URL generated successfully',
      data: { downloadUrl: result.downloadUrl, file: result.file, expiresIn: 900 },
    };
  }

  /** GET /files/:id/view */
  @Get(':id/view')
  async view(@Param('id') id: string, @CurrentUser() user: any) {
    this.requireValidId(id);
    const result = await this.filesService.findOneWithViewUrl(id, user);
    return {
      success: true,
      message: 'View URL generated successfully',
      data: { viewUrl: result.viewUrl, file: result.file, expiresIn: 900 },
    };
  }

  /** PATCH /files/:id — update description / tags */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateFileDto,
    @CurrentUser() user: any,
  ) {
    this.requireValidId(id);
    const data = await this.filesService.updateFile(id, dto, user);
    return { success: true, message: 'File updated successfully', data };
  }

  /** PATCH /files/:id/rename */
  @Patch(':id/rename')
  async rename(
    @Param('id') id: string,
    @Body() dto: RenameFileDto,
    @CurrentUser() user: any,
  ) {
    this.requireValidId(id);
    const file = await this.filesService.rename(id, dto, user);
    return { success: true, message: 'File renamed successfully', data: file };
  }

  /** PATCH /files/:id/restore */
  @Patch(':id/restore')
  @HttpCode(HttpStatus.OK)
  async restore(@Param('id') id: string, @CurrentUser() user: any) {
    this.requireValidId(id);
    const result = await this.filesService.restore(id, user);
    return { success: true, ...result };
  }

  /** DELETE /files/:id/permanent */
  @Delete(':id/permanent')
  @HttpCode(HttpStatus.OK)
  async permanentDelete(@Param('id') id: string, @CurrentUser() user: any) {
    this.requireValidId(id);
    const result = await this.filesService.permanentDelete(id, user);
    return { success: true, ...result };
  }

  /** DELETE /files/:id — soft delete */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async softDelete(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    this.requireValidId(id);
    const result = await this.filesService.softDelete(id, user);
    return { success: true, ...result };
  }

  /* ─── Helper ──────────────────────────────── */
  private requireValidId(id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Invalid file ID');
    }
  }
}
