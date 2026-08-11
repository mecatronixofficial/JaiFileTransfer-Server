import {
  IsEmail,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  IsBoolean,
  IsNumber,
  Min,
  Max,
  IsPositive,
  IsUrl,
  IsArray,
  ArrayNotEmpty,
  IsMongoId,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { Role } from '../../common/enums';

/* ─── Common transforms ──────────────────────── */
const normalizeString = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

const normalizeEmail = () =>
  Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase().trim() : value,
  );

/* ─── Password regex ─────────────────────────── */
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).+$/;

/* =========================
   CREATE USER DTO
========================= */
export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @normalizeString()
  name: string;

  @IsEmail()
  @IsNotEmpty()
  @normalizeEmail()
  email: string;

  @IsString()
  @MinLength(8)
  @MaxLength(50)
  @Matches(PASSWORD_REGEX, {
    message: 'Password must include uppercase, lowercase, number, and symbol',
  })
  password: string;

  @IsEnum(Role)
  @IsOptional()
  role?: Role;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  @normalizeString()
  department?: string;

  @IsString()
  @IsOptional()
  @Matches(/^[0-9]{10}$/, { message: 'Phone must be a valid 10-digit number' })
  phone?: string;
}

/* =========================
   UPDATE USER DTO (admin)
========================= */
export class UpdateUserDto {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  @normalizeString()
  name?: string;

  @IsEmail()
  @IsOptional()
  @normalizeEmail()
  email?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  @normalizeString()
  department?: string;

  @IsString()
  @IsOptional()
  @Matches(/^[0-9]{10}$/, { message: 'Phone must be a valid 10-digit number' })
  phone?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsEnum(Role)
  @IsOptional()
  role?: Role;
}

/* =========================
   UPDATE PROFILE DTO (self)
   Only fields a user may update on themselves.
========================= */
export class UpdateProfileDto {
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  @MaxLength(100)
  @normalizeString()
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  @normalizeString()
  department?: string | null;

  @IsString()
  @IsOptional()
  @Matches(/^[0-9]{10}$/, { message: 'Phone must be a valid 10-digit number' })
  phone?: string | null;

  @IsUrl()
  @IsOptional()
  avatar?: string | null;
}

export class ReorderUsersDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsMongoId({ each: true })
  userIds: string[];
}

export class UpdateNotificationPreferencesDto {
  @IsBoolean()
  @IsOptional()
  fileShared?: boolean;

  @IsBoolean()
  @IsOptional()
  uploadComplete?: boolean;

  @IsBoolean()
  @IsOptional()
  downloadActivity?: boolean;

  @IsBoolean()
  @IsOptional()
  systemUpdates?: boolean;
}

export class UpdateWorkspacePreferencesDto {
  @IsIn(['en', 'hi', 'ta'])
  @IsOptional()
  language?: 'en' | 'hi' | 'ta';

  @IsIn(['12', '24'])
  @IsOptional()
  timeFormat?: '12' | '24';
}

/* =========================
   CHANGE PASSWORD DTO
========================= */
export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @IsString()
  @MinLength(8)
  @MaxLength(50)
  @Matches(PASSWORD_REGEX, {
    message: 'Password must include uppercase, lowercase, number, and symbol',
  })
  newPassword: string;
}

/* =========================
   CHANGE EMAIL DTO (self — OTP verified upstream)
========================= */
export class ChangeEmailDto {
  @IsEmail()
  @IsNotEmpty()
  @normalizeEmail()
  newEmail: string;

  @IsString()
  @IsNotEmpty()
  otp: string;
}

/* =========================
   UPDATE QUOTA DTO (admin)
========================= */
export class UpdateQuotaDto {
  @IsNumber()
  @IsPositive()
  @Min(100 * 1024 * 1024)       // 100 MB minimum
  @Max(1024 * 1024 * 1024 * 1024) // 1 TB maximum
  @Type(() => Number)
  quotaBytes: number;
}

/* =========================
   LIST USERS QUERY DTO
========================= */
export class ListUsersDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsEnum(Role)
  @IsOptional()
  role?: Role;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  })
  @IsBoolean()
  isActive?: boolean;
}
