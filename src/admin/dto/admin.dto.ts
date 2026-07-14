import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { Role } from '../../common/enums';

/* =========================
   BASE
========================= */
class AdminListDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

/* =========================
   USERS
========================= */
export class AdminUsersDto extends AdminListDto {
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  isActive?: boolean;
}

/* =========================
   FILES
========================= */
export class AdminFilesDto extends AdminListDto {
  @IsOptional()
  @IsString()
  mimeType?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeTrashed?: boolean;
}

/* =========================
   TRANSFERS
========================= */
export class AdminTransfersDto extends AdminListDto {
  @IsOptional()
  @IsIn(['active', 'expired', 'disabled'])
  status?: string;

  @IsOptional()
  @IsIn(['email', 'link', 'qr'])
  method?: string;
}

/* =========================
   LINKS
========================= */
export class AdminLinksDto extends AdminListDto {
  @IsOptional()
  @IsIn(['active', 'expired', 'disabled'])
  status?: string;

  @IsOptional()
  @IsIn(['share', 'transfer'])
  type?: string;

  @IsOptional()
  @IsIn(['email', 'link', 'qr'])
  method?: string;

  @IsOptional()
  @IsIn(['view', 'download'])
  permission?: string;
}

/* =========================
   UPLOAD SESSIONS
========================= */
export class AdminSessionsDto extends AdminListDto {
  @IsOptional()
  @IsIn(['uploading', 'completed', 'failed', 'aborted'])
  status?: string;
}
