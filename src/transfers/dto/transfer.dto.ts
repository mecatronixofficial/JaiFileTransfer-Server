import {
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  Max,
  IsEmail,
  ArrayMaxSize,
  IsObject,
  IsNumber,
  IsMongoId,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';

export const TRANSFER_SEND_METHODS = ['email', 'link', 'qr'] as const;
export type TransferSendMethod = (typeof TRANSFER_SEND_METHODS)[number];

export class SendTransferDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsArray()
  @IsMongoId({ each: true })
  @IsOptional()
  fileIds?: string[];

  @IsArray()
  @IsMongoId({ each: true })
  @IsOptional()
  folderIds?: string[];

  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(1000)
  @IsOptional()
  fileKeys?: string[];

  /**
   * Map of fileId → relativePath for locally-uploaded files whose folder
   * structure is only known on the client (e.g. drag-dropped folders).
   */
  @IsObject()
  @IsOptional()
  relativePaths?: Record<string, string>;

  @IsNumber()
  @Min(0)
  @IsOptional()
  @Type(() => Number)
  totalSize?: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  @Type(() => Number)
  fileCount?: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  @Type(() => Number)
  folderCount?: number;

  @IsNotEmpty()
  @IsIn(TRANSFER_SEND_METHODS)
  method: TransferSendMethod;

  @IsEnum(['public', 'private', 'specific'])
  @IsOptional()
  privacy?: string;

  @IsArray()
  @IsEmail({}, { each: true })
  @ArrayMaxSize(50)
  @IsOptional()
  recipients?: string[];

  @IsString()
  @IsOptional()
  subject?: string;

  @IsString()
  @IsOptional()
  message?: string;

  @IsInt()
  @Min(1)
  @Max(365)
  @IsOptional()
  @Type(() => Number)
  expiry?: number;

  @IsDateString()
  @IsOptional()
  expiresAt?: string;

  @IsString()
  @IsOptional()
  password?: string;
}

export class PublicViewDto {
  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  password?: string;

  @IsEnum(['view', 'download'])
  @IsOptional()
  action?: 'view' | 'download';
}

export class ListTransfersDto {
  @IsInt()
  @Min(1)
  @IsOptional()
  @Type(() => Number)
  page?: number;

  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  @Type(() => Number)
  limit?: number;

  @IsEnum(['active', 'expired', 'disabled', 'all'])
  @IsOptional()
  status?: string;

  @IsEnum(['sent', 'received', 'all'])
  @IsOptional()
  direction?: string;
}
