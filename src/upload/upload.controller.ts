/// <reference types="multer" />
import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { UploadService } from './upload.service';
import { FilesService } from '../files/files.service';
import { TransfersService } from '../transfers/transfers.service';
import {
  PresignedUrlDto,
  InitiateMultipartDto,
  CompleteMultipartDto,
  GetPartUrlDto,
  AbortMultipartDto,
  FolderUploadDto,
  GetUploadSessionsDto,
} from './dto/upload.dto';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ClientIp } from '../common/decorators/client-ip.decorator';
import { Role } from '../common/enums';
import {
  TRANSFER_SEND_METHODS,
  TransferSendMethod,
} from '../transfers/dto/transfer.dto';

const MAX_MULTIPART_PART_BYTES = 128 * 1024 * 1024;
// This route buffers multipart/form-data in application memory. Keep it for
// convenient small uploads; large files must use the resumable multipart API.
const MAX_DIRECT_UPLOAD_BYTES = 100 * 1024 * 1024;

@Controller('upload')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UploadController {
  constructor(
    private readonly uploadService: UploadService,
    private readonly filesService: FilesService,
    private readonly transfersService: TransfersService,
  ) {}

  /* =========================
     SINGLE FILE — PRESIGNED URL
  ========================= */
  @Post('presigned-url')
  @HttpCode(HttpStatus.OK)
  async getPresignedUrl(
    @Body() dto: PresignedUrlDto,
    @CurrentUser() user: any,
    @ClientIp() ip: string,
  ) {
    const result = await this.uploadService.generatePresignedUrl(
      dto,
      user._id.toString(),
      user.organizationId?.toString?.() ?? null,
    );

    return {
      success: true,
      message:
        'Presigned upload URL generated. PUT your file directly to this URL.',
      data: result,
    };
  }

  /* =========================
     MULTIPART — INITIATE
  ========================= */
  @Post('multipart/initiate')
  @HttpCode(HttpStatus.OK)
  async initiateMultipart(
    @Body() dto: InitiateMultipartDto,
    @CurrentUser() user: any,
    @ClientIp() ip: string,
  ) {
    const result = await this.uploadService.initiateMultipartUpload(
      dto,
      user._id.toString(),
      user.organizationId?.toString?.() ?? null,
    );

    return {
      success: true,
      message: dto.partCount
        ? `Multipart initiated with ${dto.partCount} pre-generated part URLs`
        : 'Multipart initiated. Request part URLs via POST /upload/multipart/part-url',
      data: result,
    };
  }

  /* =========================
     MULTIPART — GET PART URL
  ========================= */
  @Post('multipart/part-url')
  @HttpCode(HttpStatus.OK)
  async getPartUrl(@Body() dto: GetPartUrlDto, @CurrentUser() user: any) {
    const result = await this.uploadService.getPresignedPartUrl(
      dto,
      user._id.toString(),
    );

    return {
      success: true,
      message: `Presigned URL for part ${dto.partNumber}. PUT the part chunk to this URL.`,
      data: result,
    };
  }

  /* =========================
     MULTIPART — SERVER-SIDE PART UPLOAD FALLBACK
     Avoids browser-to-R2 CORS failures by uploading one chunk through API.
  ========================= */
  @Post('multipart/upload-part')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('part', { limits: { fileSize: MAX_MULTIPART_PART_BYTES } }),
  )
  async uploadMultipartPart(
    @UploadedFile() part: Express.Multer.File,
    @Body() body: any,
    @CurrentUser() user: any,
  ) {
    const result = await this.uploadService.uploadMultipartPart(
      part,
      String(body?.uploadId ?? ''),
      String(body?.key ?? ''),
      Number(body?.partNumber),
      user._id.toString(),
    );

    return {
      success: true,
      message: `Multipart part ${result.partNumber} uploaded through server fallback`,
      data: result,
    };
  }

  /* =========================
     MULTIPART — COMPLETE
  ========================= */
  @Post('multipart/complete')
  @HttpCode(HttpStatus.OK)
  async completeMultipart(
    @Body() dto: CompleteMultipartDto,
    @CurrentUser() user: any,
    @ClientIp() ip: string,
  ) {
    const result = await this.uploadService.completeMultipartUpload(
      dto,
      user._id.toString(),
    );

    return {
      success: true,
      message: 'Multipart upload completed successfully',
      data: result,
    };
  }

  /* =========================
     MULTIPART — ABORT
  ========================= */
  @Post('multipart/abort')
  @HttpCode(HttpStatus.OK)
  async abortMultipart(
    @Body() dto: AbortMultipartDto,
    @CurrentUser() user: any,
  ) {
    const result = await this.uploadService.abortMultipartUpload(
      dto.uploadId,
      dto.key,
      user._id.toString(),
    );

    return { success: true, ...result };
  }

  /* =========================
     DIRECT FILE UPLOAD (server-side — no R2 CORS required)
     Accepts multipart/form-data with a `file` field and optional `folderId`.
     Uploads to R2 server-side, saves metadata, returns the file record.
  ========================= */
  @Post('file')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_DIRECT_UPLOAD_BYTES } }),
  )
  async uploadFileDirect(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: any,
    @CurrentUser() user: any,
    @ClientIp() ip: string,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    const folderId = body?.folderId;

    const uploadResult = await this.uploadService.uploadFileDirect(
      file,
      folderId,
      user._id.toString(),
    );

    const saved = await this.filesService.saveMetadata(
      {
        key: uploadResult.key,
        originalName: uploadResult.originalName,
        size: uploadResult.size,
        mimeType: uploadResult.mimeType,
        folderId: uploadResult.folderId,
        fileId: uploadResult.fileId,
      },
      user._id.toString(),
      user.organizationId?.toString?.() ?? null,
    );

    /* Normalise the Mongoose document to a plain object and guarantee `id`
       is always present as a top-level string field alongside `_id`. */
    const fileObj = saved.toObject({ virtuals: true });
    const data: Record<string, any> = {
      ...fileObj,
      id: String(fileObj._id),
    };

    if (this.isTruthy(body?.createTransfer)) {
      const transferResult = await this.transfersService.send(
        {
          fileIds: [String(fileObj._id)],
          method: this.parseTransferMethod(body?.transferMethod ?? body?.method),
          title: body?.title,
          subject: body?.subject,
          message: body?.message,
          recipients: this.parseRecipients(body?.recipients),
          privacy: body?.privacy,
          expiry: body?.expiry ? Number(body.expiry) : undefined,
          password: body?.password,
        },
        user._id.toString(),
        user.name ?? user.email,
        user.organizationId?.toString?.() ?? null,
      );
      data.transfer = transferResult;
      data.link = transferResult.link;
    }

    return {
      success: true,
      message: data.transfer
        ? 'File uploaded and transfer link created successfully'
        : 'File uploaded successfully',
      data,
    };
  }

  private isTruthy(value: unknown): boolean {
    return value === true || value === 'true' || value === '1' || value === 1;
  }

  private parseTransferMethod(value: unknown): TransferSendMethod {
    const method = typeof value === 'string' && value.trim() ? value : 'link';
    if (TRANSFER_SEND_METHODS.includes(method as TransferSendMethod)) {
      return method as TransferSendMethod;
    }

    throw new BadRequestException('Unsupported transfer method');
  }

  private parseRecipients(value: unknown): string[] | undefined {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (typeof value !== 'string' || !value.trim()) return undefined;

    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      // Fall back to comma-separated form-data values.
    }

    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  /* =========================
     FOLDER UPLOAD — INITIATE
     Creates folder hierarchy and returns presigned URLs for all files.
  ========================= */
  @Post('folder')
  @HttpCode(HttpStatus.OK)
  async uploadFolder(
    @Body() dto: FolderUploadDto,
    @CurrentUser() user: any,
    @ClientIp() ip: string,
  ) {
    const result = await this.uploadService.initiateFolderUpload(
      dto,
      user._id.toString(),
      user.organizationId?.toString?.() ?? null,
    );

    return {
      success: true,
      message: result.message,
      data: result,
    };
  }

  /* =========================
     UPLOAD SESSIONS — LIST (user's own)
  ========================= */
  @Get('sessions')
  async getSessions(
    @Query() dto: GetUploadSessionsDto,
    @CurrentUser() user: any,
  ) {
    const data = await this.uploadService.getUserSessions(
      user._id.toString(),
      dto,
    );
    return { success: true, message: 'Upload sessions retrieved', data };
  }

  /* =========================
     UPLOAD SESSIONS — GET ONE
  ========================= */
  @Get('sessions/:id')
  async getSession(@Param('id') id: string, @CurrentUser() user: any) {
    const data = await this.uploadService.getSession(id, user._id.toString());
    return { success: true, message: 'Upload session retrieved', data };
  }

  /* =========================
     UPLOAD SESSIONS — CANCEL
  ========================= */
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.OK)
  async cancelSession(@Param('id') id: string, @CurrentUser() user: any) {
    const result = await this.uploadService.cancelSession(
      id,
      user._id.toString(),
    );
    return { success: true, ...result };
  }

  /* =========================
     ADMIN — UPLOAD STATS
  ========================= */
  @Get('admin/stats')
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  async getAdminStats() {
    const data = await this.uploadService.getAdminStats();
    return { success: true, message: 'Upload stats retrieved', data };
  }
}
