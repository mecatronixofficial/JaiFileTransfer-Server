import {
  IsEmail,
  IsNotEmpty,
  IsString,
  IsEnum,
  IsOptional,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { OtpPurpose } from '../../common/enums';

/**
 * 🔐 Common Validators
 */
const PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&]).+$/;

const OTP_REGEX = /^[0-9]{6}$/;

/**
 * 🔧 COMMON TRANSFORM
 */
const trim = () =>
  Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/**
 * 🔑 LOGIN DTO
 */
export class LoginDto {
  @IsEmail()
  @trim()
  @Transform(({ value }) => value.toLowerCase())
  email: string;

  @IsString()
  @trim()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(64) // ✅ increased
  password: string;
}

/**
 * 🔐 VERIFY OTP DTO
 */
export class VerifyOtpDto {
  @IsEmail()
  @trim()
  @Transform(({ value }) => value.toLowerCase())
  email: string;

  @Matches(OTP_REGEX, { message: 'OTP must be 6 digits' })
  @trim()
  otp: string;

  @IsEnum(OtpPurpose)
  purpose: OtpPurpose; // ✅ REQUIRED (security fix)

  @IsOptional()
  @IsString()
  @trim()
  @MaxLength(100)
  fileId?: string;
}

/**
 * 🔁 REQUEST OTP DTO
 */
export class RequestOtpDto {
  @IsEnum(OtpPurpose)
  purpose: OtpPurpose;

  @IsOptional()
  @IsString()
  @trim()
  @MaxLength(100)
  fileId?: string;
}

/**
 * 🔁 RESEND OTP DTO
 */
export class ResendOtpDto {
  @IsEmail()
  @trim()
  @Transform(({ value }) => value.toLowerCase())
  email: string;

  @IsOptional()
  @IsEnum(OtpPurpose)
  purpose?: OtpPurpose;
}

/**
 * 🔒 FORGOT PASSWORD DTO
 */
export class ForgotPasswordDto {
  @IsEmail()
  @trim()
  @Transform(({ value }) => value.toLowerCase())
  email: string;
}

/**
 * 🔐 RESET PASSWORD DTO
 */
export class ResetPasswordDto {
  @IsEmail()
  @trim()
  @Transform(({ value }) => value.toLowerCase())
  email: string;

  @Matches(OTP_REGEX, { message: 'OTP must be 6 digits' })
  @trim()
  otp: string;

  @IsString()
  @trim()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(64) // ✅ increased
  @Matches(PASSWORD_REGEX, {
    message:
      'Password must include uppercase, lowercase, number and special character',
  })
  newPassword: string;
}

export class VerifyTwoFactorLoginDto {
  @IsEmail()
  @trim()
  @Transform(({ value }) => value.toLowerCase())
  email: string;

  @Matches(OTP_REGEX, { message: 'OTP must be 6 digits' })
  @trim()
  otp: string;
}

export class UpdateTwoFactorDto {
  @Matches(OTP_REGEX, { message: 'OTP must be 6 digits' })
  @trim()
  otp: string;
}

export class DeleteOwnAccountDto {
  @Matches(OTP_REGEX, { message: 'OTP must be 6 digits' })
  @trim()
  otp: string;
}
