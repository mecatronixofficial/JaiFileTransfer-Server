import {
  ArrayMaxSize,
  IsArray,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  IsIn,
  IsBoolean,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { MAX_FILE_SIZE } from '../../upload/dto/upload.dto';

/* =========================
   SAVE FILE METADATA
========================= */
export class SaveFileMetadataDto {
  @IsString()
  @IsOptional()
  fileName?: string;

  @IsString()
  @IsNotEmpty()
  originalName: string;

  @IsMongoId()
  @IsOptional()
  fileId?: string;

  @IsString()
  @IsNotEmpty()
  mimeType: string;

  @IsNumber()
  @Min(1)
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

  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  @ArrayMaxSize(20)
  @IsOptional()
  tags?: string[];
}

/* =========================
   FILE QUERY
========================= */
export class FileQueryDto {
  @Transform(({ value }) =>
    value === '' || value === 'null' || value === 'undefined' ? undefined : value,
  )
  @IsMongoId()
  @IsOptional()
  folderId?: string;

  @IsString()
  @IsOptional()
  search?: string;

  /** Filter by mimeType prefix (e.g. "image") or exact (e.g. "image/jpeg") */
  @IsString()
  @IsOptional()
  mimeType?: string;

  /** UI file category filter */
  @IsIn(['image', 'video', 'document', 'spreadsheet', 'other'])
  @IsOptional()
  category?: 'image' | 'video' | 'document' | 'spreadsheet' | 'other';

  /** Category pages hide files inside uploaded folders unless enabled */
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  @IsOptional()
  includeFolderFiles?: boolean;

  /** Filter by a single tag */
  @IsString()
  @IsOptional()
  @MaxLength(50)
  tag?: string;

  /** Admin-only: filter by owner user ID */
  @IsMongoId()
  @IsOptional()
  uploadedBy?: string;

  /** Superadmin-only: filter by uploader role */
  @IsIn(['superadmin', 'admin', 'user'])
  @IsOptional()
  ownerRole?: 'superadmin' | 'admin' | 'user';

  @Type(() => Number)
  @IsOptional()
  page: number = 1;

  @Type(() => Number)
  @IsOptional()
  limit: number = 20;

  @IsString()
  @IsOptional()
  sortBy: string = 'createdAt';

  @IsIn(['asc', 'desc'])
  @IsOptional()
  sortOrder: 'asc' | 'desc' = 'desc';
}

/* =========================
   UPDATE FILE
========================= */
export class UpdateFileDto {
  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;

  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  @ArrayMaxSize(20)
  @IsOptional()
  tags?: string[];
}

/* =========================
   RENAME FILE
========================= */
export class RenameFileDto {
  @IsString()
  @IsNotEmpty()
  fileName: string;
}

/* =========================
   SHARE FILE
========================= */
export class ShareFileDto {
  @IsArray()
  @IsMongoId({ each: true })
  userIds: string[];
}

/* =========================
   BULK DELETE
========================= */
export class BulkDeleteDto {
  @IsArray()
  @IsMongoId({ each: true })
  @ArrayMaxSize(100)
  fileIds: string[];
}

/* =========================
   BULK RESTORE
========================= */
export class BulkRestoreDto {
  @IsArray()
  @IsMongoId({ each: true })
  @ArrayMaxSize(100)
  fileIds: string[];
}

/* =========================
   BULK MOVE
========================= */
export class BulkMoveDto {
  @IsArray()
  @IsMongoId({ each: true })
  @ArrayMaxSize(100)
  fileIds: string[];

  @IsMongoId()
  @IsOptional()
  folderId?: string;
}
