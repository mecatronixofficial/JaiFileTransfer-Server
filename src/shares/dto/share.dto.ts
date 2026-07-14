import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ShareType, SharePermission, ResourceType, ShareAccessAction } from '../../common/enums';

/* =========================
   CREATE SHARE
========================= */
export class CreateShareDto {
  @IsEnum(ShareType)
  type: ShareType;

  @IsEnum(ResourceType)
  resourceType: ResourceType;

  @ValidateIf((o) => o.resourceType === ResourceType.FILE)
  @IsMongoId()
  fileId?: string;

  @ValidateIf((o) => o.resourceType === ResourceType.FOLDER)
  @IsMongoId()
  folderId?: string;

  @IsArray()
  @IsEmail({}, { each: true })
  @IsOptional()
  sharedWithEmails?: string[];

  @IsArray()
  @IsMongoId({ each: true })
  @IsOptional()
  sharedWithUserIds?: string[];

  @IsEnum(SharePermission)
  @IsOptional()
  permission?: SharePermission;

  @IsDateString()
  @IsOptional()
  expiresAt?: string;

  @IsString()
  @IsOptional()
  password?: string;

  @IsString()
  @MaxLength(200)
  @IsOptional()
  name?: string;

  @IsString()
  @MaxLength(1000)
  @IsOptional()
  message?: string;
}

/* =========================
   UPDATE SHARE
========================= */
export class UpdateShareDto {
  @IsEnum(SharePermission)
  @IsOptional()
  permission?: SharePermission;

  @IsDateString()
  @IsOptional()
  expiresAt?: string | null;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsString()
  @IsOptional()
  password?: string | null;

  @IsArray()
  @IsEmail({}, { each: true })
  @IsOptional()
  sharedWithEmails?: string[];

  @IsArray()
  @IsMongoId({ each: true })
  @IsOptional()
  sharedWithUserIds?: string[];

  @IsString()
  @MaxLength(200)
  @IsOptional()
  name?: string | null;

  @IsString()
  @MaxLength(1000)
  @IsOptional()
  message?: string | null;
}

/* =========================
   SHARE QUERY (list)
========================= */
export class ShareQueryDto {
  @IsEnum(ShareType)
  @IsOptional()
  type?: ShareType;

  @IsEnum(ResourceType)
  @IsOptional()
  resourceType?: ResourceType;

  @IsBoolean()
  @IsOptional()
  @Type(() => Boolean)
  isActive?: boolean;

  @IsNumber()
  @Min(1)
  @IsOptional()
  @Type(() => Number)
  page?: number = 1;

  @IsNumber()
  @Min(1)
  @IsOptional()
  @Type(() => Number)
  limit?: number = 20;
}

/* =========================
   ACCESS LOG QUERY
========================= */
export class AccessQueryDto {
  @IsEnum(ShareAccessAction)
  @IsOptional()
  action?: ShareAccessAction;

  @IsNumber()
  @Min(1)
  @IsOptional()
  @Type(() => Number)
  page?: number = 1;

  @IsNumber()
  @Min(1)
  @IsOptional()
  @Type(() => Number)
  limit?: number = 50;
}

/* =========================
   PUBLIC LINK ACCESS
========================= */
export class AccessLinkDto {
  @IsString()
  @IsOptional()
  password?: string;
}
