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
import { Transform, Type } from 'class-transformer';
import { normalizeUploadMimeType } from '../file-type.util';

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
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
  'application/vnd.openxmlformats-officedocument.presentationml.template',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  'application/vnd.ms-word.document.macroenabled.12',
  'application/vnd.ms-word.template.macroenabled.12',
  'application/vnd.ms-excel.sheet.macroenabled.12',
  'application/vnd.ms-excel.template.macroenabled.12',
  'application/vnd.ms-excel.sheet.binary.macroenabled.12',
  'application/vnd.ms-excel.addin.macroenabled.12',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12',
  'application/vnd.ms-powerpoint.template.macroenabled.12',
  'application/vnd.ms-powerpoint.slideshow.macroenabled.12',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.graphics',
  'application/vnd.visio',
  'application/vnd.ms-visio.drawing',
  'application/vnd.ms-project',
  'application/onenote',
  'application/x-mspublisher',
  'application/vnd.apple.pages',
  'application/vnd.apple.numbers',
  'application/vnd.apple.keynote',
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
  'application/yaml',
  'application/sql',
  'application/x-ndjson',
  'text/tab-separated-values',
  // Email / Calendar
  'message/rfc822',
  'application/vnd.ms-outlook',
  'application/mbox',
  'text/calendar',
  'text/vcard',
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
  'image/vnd.adobe.photoshop',
  'application/postscript',
  'application/x-indesign',
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
  'application/x-xz',
  'application/zstd',
  'application/vnd.ms-cab-compressed',
  'application/x-iso9660-image',
  // CAD / BIM / 3D
  'image/vnd.dwg',
  'image/vnd.dxf',
  'model/step',
  'model/iges',
  'model/stl',
  'model/obj',
  'model/gltf+json',
  'model/gltf-binary',
  'application/x-step',
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
  // Databases / Analytics / Finance
  'application/vnd.sqlite3',
  'application/vnd.apache.parquet',
  'application/avro',
  'application/x-ofx',
  'application/vnd.intu.qfx',
  // Public certificates and signatures (private-key containers remain blocked)
  'application/x-pem-file',
  'application/pkix-cert',
  'application/x-x509-ca-cert',
  'application/x-pkcs7-certificates',
  'application/pkcs7-signature',
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
  @Transform(({ value, obj }) => normalizeUploadMimeType(obj.fileName, value))
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
  @Transform(({ value, obj }) => normalizeUploadMimeType(obj.fileName, value))
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
  @Transform(({ value, obj }) => normalizeUploadMimeType(obj.fileName, value))
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
  @Transform(({ value, obj }) =>
    normalizeUploadMimeType(obj.originalName, value),
  )
  @IsIn(ALLOWED_MIME_TYPES, { message: 'Unsupported MIME type' })
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
