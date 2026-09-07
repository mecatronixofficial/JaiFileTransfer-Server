import {
  IsArray,
  IsEnum,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { normalizeUploadMimeType } from '../file-type.util';

/* =========================
   CONSTANTS
========================= */
export const MAX_FILE_SIZE = 100 * 1024 * 1024 * 1024; // 100 GB

/* =========================
   PRESIGNED URL (single file)
========================= */
export class PresignedUrlDto {
  @IsString()
  @IsNotEmpty()
  fileName: string;

  @IsString()
  @IsNotEmpty()
  @Transform(({ value, obj }) => normalizeUploadMimeType(obj.fileName, value))
  mimeType: string = 'application/octet-stream';

  @IsNumber()
  @Min(0)
  @Max(MAX_FILE_SIZE)
  @Type(() => Number)
  fileSize: number;

  @IsMongoId()
  @IsOptional()
  folderId?: string;
}

/* =========================
   INIT MULTIPART
========================= */
export class InitiateMultipartDto {
  @IsString()
  @IsNotEmpty()
  fileName: string;

  @IsString()
  @IsNotEmpty()
  @Transform(({ value, obj }) => normalizeUploadMimeType(obj.fileName, value))
  mimeType: string = 'application/octet-stream';

  @IsNumber()
  @Min(1)
  @Max(MAX_FILE_SIZE)
  @Type(() => Number)
  fileSize: number;

  @IsMongoId()
  @IsOptional()
  folderId?: string;

  /** Requested multipart chunk size. S3-compatible storage requires at least 5 MiB. */
  @IsNumber()
  @Min(5 * 1024 * 1024)
  @Max(128 * 1024 * 1024)
  @IsOptional()
  @Type(() => Number)
  partSize?: number;

  /** Total number of parts — include to get presigned part URLs upfront */
  @IsNumber()
  @Min(1)
  @Max(10000)
  @IsOptional()
  @Type(() => Number)
  partCount?: number;
}

/* =========================
   GET PRESIGNED PART URL
========================= */
export class GetPartUrlDto {
  @IsString()
  @IsNotEmpty()
  uploadId: string;

  @IsString()
  @IsNotEmpty()
  key: string;

  @IsNumber()
  @Min(1)
  @Max(10000)
  @Type(() => Number)
  partNumber: number;
}

/* =========================
   MULTIPART PART
========================= */
export class MultipartPartDto {
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  partNumber: number;

  @IsString()
  @IsNotEmpty()
  etag: string;
}

/* =========================
   COMPLETE MULTIPART
========================= */
export class CompleteMultipartDto {
  @IsString()
  @IsNotEmpty()
  uploadId: string;

  @IsString()
  @IsNotEmpty()
  key: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MultipartPartDto)
  parts: MultipartPartDto[];
}

/* =========================
   ABORT MULTIPART
========================= */
export class AbortMultipartDto {
  @IsString()
  @IsNotEmpty()
  uploadId: string;

  @IsString()
  @IsNotEmpty()
  key: string;
}

/* =========================
   FOLDER UPLOAD — single file entry
========================= */
export class FolderFileDto {
  @IsString()
  @IsNotEmpty()
  fileName: string;

  @IsString()
  @IsNotEmpty()
  @Transform(({ value, obj }) => normalizeUploadMimeType(obj.fileName, value))
  mimeType: string = 'application/octet-stream';

  @IsNumber()
  @Min(0)
  @Max(MAX_FILE_SIZE)
  @Type(() => Number)
  fileSize: number;

  /**
   * Relative path within the folder tree.
   * e.g. "index.html" | "css/styles.css" | "img/logo.png"
   */
  @IsString()
  @IsOptional()
  relativePath?: string;
}

/* =========================
   FOLDER UPLOAD — root request
========================= */
export class FolderUploadDto {
  @IsString()
  @IsNotEmpty()
  folderName: string;

  @IsMongoId()
  @IsOptional()
  parentFolderId?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FolderFileDto)
  files: FolderFileDto[] = [];

  /** Root-relative directory paths, including empty directories. */
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  directories?: string[];
}

/* =========================
   BATCH FILE METADATA (after folder upload completes)
========================= */
export class BatchFileMetaDto {
  @IsMongoId()
  @IsOptional()
  fileId?: string;

  @IsString()
  @IsNotEmpty()
  fileName: string;

  @IsString()
  @IsNotEmpty()
  originalName: string;

  @IsString()
  @IsNotEmpty()
  @Transform(({ value, obj }) =>
    normalizeUploadMimeType(obj.originalName, value),
  )
  mimeType: string = 'application/octet-stream';

  @IsNumber()
  @Min(0)
  @Max(MAX_FILE_SIZE)
  @Type(() => Number)
  size: number;

  @IsString()
  @IsNotEmpty()
  key: string;

  @IsMongoId()
  @IsOptional()
  folderId?: string;

  @IsMongoId()
  @IsOptional()
  uploadSessionId?: string;

  @IsString()
  @IsOptional()
  description?: string;
}

export class BatchSaveMetadataDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BatchFileMetaDto)
  files: BatchFileMetaDto[];
}

/* =========================
   UPLOAD SESSION QUERY
========================= */
export class GetUploadSessionsDto {
  @IsEnum(['uploading', 'completed', 'failed', 'aborted', 'all'])
  @IsOptional()
  status?: 'uploading' | 'completed' | 'failed' | 'aborted' | 'all';

  @IsNumber()
  @Min(1)
  @Max(100)
  @IsOptional()
  @Type(() => Number)
  limit?: number;
}
