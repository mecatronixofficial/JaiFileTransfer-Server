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
  IsIn,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';

/* =========================
   CONSTANTS
========================= */
export const ALLOWED_MIME_TYPES = [
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/rtf',
  'application/epub+zip',
  // Text / Code
  'text/plain',
  'text/csv',
  'text/html',
  'text/css',
  'text/markdown',
  'text/x-markdown',
  'application/json',
  'application/xml',
  'text/xml',
  'application/javascript',
  'text/javascript',
  'application/typescript',
  'text/typescript',
  'application/x-python',
  'text/x-python',
  'application/x-sh',
  'text/x-sh',
  'text/x-java-source',
  'text/x-c',
  'text/x-c++',
  'text/x-rust',
  'text/x-go',
  'application/x-yaml',
  'text/yaml',
  'application/toml',
  'text/toml',
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/tiff',
  'image/avif',
  'image/heic',
  'image/heif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  // Fonts
  'font/ttf',
  'font/otf',
  'font/woff',
  'font/woff2',
  'application/font-woff',
  'application/font-woff2',
  'application/x-font-ttf',
  'application/x-font-otf',
  // Archives
  'application/zip',
  'application/x-zip-compressed',
  'application/x-zip',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-7z-compressed',
  'application/gzip',
  'application/x-tar',
  'application/x-bzip2',
  'application/x-bzip',
  // Video
  'video/mp4',
  'application/mp4',
  'video/mpeg',
  'video/quicktime',
  'video/webm',
  'video/x-msvideo',
  'video/x-matroska',
  'video/mp2t',
  'video/x-m4v',
  'video/hevc',
  'video/h265',
  'video/3gpp2',
  'video/3gpp',
  'video/3gp',
  'video/3g2',
  'video/x-flv',
  'video/ogg',
  // Audio
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
  'audio/flac',
  'audio/x-flac',
  'audio/x-wav',
  'audio/x-ms-wma',
  'audio/3gpp',
  'audio/3gpp2',
  'audio/3gp',
  'audio/3g2',
  // Misc
  'application/octet-stream',
];

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
  @IsIn(ALLOWED_MIME_TYPES, { message: 'Unsupported MIME type' })
  mimeType: string;

  @IsNumber()
  @Min(1)
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
  @IsIn(ALLOWED_MIME_TYPES, { message: 'Unsupported MIME type' })
  mimeType: string;

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
  @IsIn(ALLOWED_MIME_TYPES, { message: 'Unsupported MIME type' })
  mimeType: string;

  @IsNumber()
  @Min(1)
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
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => FolderFileDto)
  files: FolderFileDto[];
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
  mimeType: string;

  @IsNumber()
  @Min(1)
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
