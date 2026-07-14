import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';

import { UsersService } from '../users/users.service';
import { OtpService } from '../otp/otp.service';
import {
  LoginDto,
  ResetPasswordDto,
  VerifyOtpDto,
  VerifyTwoFactorLoginDto,
} from './dto/auth.dto';
import { OtpPurpose } from '../common/enums';
import { JwtPayload } from './strategies/jwt.strategy';

const DEFAULT_ACCESS_TOKEN_EXPIRY = '1d';
const DEFAULT_REFRESH_TOKEN_EXPIRY = '30d';
const REFRESH_TOKEN_HASH_ROUNDS = 10;
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/;

/** Tag for refresh tokens vs access tokens — prevents token swap attacks. */
type TokenType = 'access' | 'refresh';

interface SignedPayload extends JwtPayload {
  type: TokenType;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly issuer: string;
  private readonly audience: string;
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly accessTokenExpiry: string;
  private readonly refreshTokenExpiry: string;

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly otpService: OtpService,
    private readonly configService: ConfigService,
  ) {
    this.issuer = this.configService.get<string>('jwt.issuer') ?? 'jai-india-api';
    this.audience = this.configService.get<string>('jwt.audience') ?? 'jai-india-users';
    this.accessTokenExpiry =
      this.configService.get<string>('jwt.accessTokenExpiry') ?? DEFAULT_ACCESS_TOKEN_EXPIRY;
    this.refreshTokenExpiry =
      this.configService.get<string>('jwt.refreshTokenExpiry') ?? DEFAULT_REFRESH_TOKEN_EXPIRY;

    // Use separate secrets for access vs refresh if available, otherwise
    // fall back to a shared secret. Two secrets is stronger — leaking your
    // access-token signing key shouldn't let an attacker forge refresh tokens.
    const sharedSecret = this.configService.get<string>('jwt.secret');
    this.accessSecret =
      this.configService.get<string>('jwt.accessSecret') ?? sharedSecret ?? '';
    this.refreshSecret =
      this.configService.get<string>('jwt.refreshSecret') ?? sharedSecret ?? '';

    if (!this.accessSecret || !this.refreshSecret) {
      throw new Error('JWT secrets are not configured');
    }
  }

  /* =========================
     LOGIN
  ========================= */
  async login(dto: LoginDto, ip: string, userAgent?: string) {
    const email = this.normalizeEmail(dto.email);

    const user = await this.usersService.findByEmail(email, true);

    // Bcrypt-compare even when the user doesn't exist, to keep response
    // timing constant. Prevents user enumeration via timing analysis.
    const dummyHash =
      '$2b$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUV';
    const passwordHash = user?.password ?? dummyHash;
    const isMatch = await bcrypt.compare(dto.password, passwordHash);

    if (!user || !isMatch) {
      this.logger.warn(`Login failed → ${email} | IP: ${ip}`);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account deactivated');
    }

    if (user.twoFactorEnabled) {
      await this.otpService.sendOtp(
        user._id.toString(),
        user.email,
        OtpPurpose.TWO_FACTOR_LOGIN,
        { ip, userAgent },
      );
      return {
        requiresTwoFactor: true as const,
        email: user.email,
      };
    }

    return {
      requiresTwoFactor: false as const,
      ...(await this.completeLogin(user._id.toString(), ip, userAgent)),
    };
  }

  async verifyTwoFactorLogin(
    dto: VerifyTwoFactorLoginDto,
    ip: string,
    userAgent?: string,
  ) {
    const user = await this.usersService.findByEmail(this.normalizeEmail(dto.email));
    if (!user || !user.isActive || !user.twoFactorEnabled) {
      throw new UnauthorizedException('Invalid two-factor challenge');
    }

    await this.otpService.verifyOtp(
      user._id.toString(),
      dto.otp,
      OtpPurpose.TWO_FACTOR_LOGIN,
    );

    return this.completeLogin(user._id.toString(), ip, userAgent);
  }

  async updateTwoFactor(userId: string, otp: string, enabled: boolean) {
    await this.otpService.verifyOtp(
      userId,
      otp,
      OtpPurpose.HIGH_RISK_ACTION,
    );
    return this.usersService.setTwoFactorEnabled(userId, enabled);
  }

  async deleteOwnAccount(userId: string, otp: string) {
    await this.otpService.verifyOtp(
      userId,
      otp,
      OtpPurpose.ACCOUNT_DELETION,
    );
    return this.usersService.deleteOwnAccount(userId);
  }

  private async completeLogin(userId: string, ip: string, userAgent?: string) {

    // Invalidate previous sessions (single-session policy).
    await this.usersService.incrementTokenVersion(userId);

    // Re-fetch to pick up the new tokenVersion.
    const updatedUser = await this.usersService.findAuthUserById(userId);
    if (!updatedUser) throw new UnauthorizedException('User not found');

    const { accessToken, refreshToken } = await this.issueTokens({
      sub: updatedUser._id.toString(),
      email: updatedUser.email,
      role: updatedUser.role,
      tokenVersion: updatedUser.tokenVersion,
    });

    await this.usersService.updateLastLogin(updatedUser._id.toString(), { ip, userAgent });

    this.logger.log(`Login success → ${updatedUser.email} | IP: ${ip}`);

    return {
      accessToken,
      refreshToken,
      user: {
        id: updatedUser._id.toString(),
        name: updatedUser.name,
        email: updatedUser.email,
        role: updatedUser.role,
        organizationId: (updatedUser as any).organizationId?.toString() ?? null,
        department: (updatedUser as any).department ?? null,
        avatar: (updatedUser as any).avatar ?? null,
      },
    };
  }

  /* =========================
     REFRESH
  ========================= */
  async refresh(refreshToken: string) {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token missing');
    }

    let payload: SignedPayload;
    try {
      payload = await this.jwtService.verifyAsync<SignedPayload>(refreshToken, {
        secret: this.refreshSecret,
        issuer: this.issuer,
        audience: this.audience,
      });
    } catch {
      throw new UnauthorizedException('Session expired');
    }

    // Reject access tokens being used as refresh tokens.
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Invalid token type');
    }

    const user = await this.usersService.findAuthUserById(payload.sub);
    if (!user || !user.refreshToken) {
      throw new UnauthorizedException('Invalid session');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account deactivated');
    }

    // Token-version check: invalidates this refresh token after password change,
    // logout-all-devices, or role change.
    if (user.tokenVersion !== payload.tokenVersion) {
      throw new UnauthorizedException('Session expired');
    }

    const isMatch = await bcrypt.compare(refreshToken, user.refreshToken);
    if (!isMatch) {
      // Token mismatch can indicate token theft — bump tokenVersion to
      // invalidate every session for safety.
      await this.usersService.incrementTokenVersion(user._id.toString());
      await this.usersService.removeRefreshToken(user._id.toString());
      this.logger.warn(
        `Refresh token mismatch → ${user.email} — all sessions revoked`,
      );
      throw new UnauthorizedException('Session mismatch');
    }

    const { accessToken, refreshToken: newRefresh } = await this.issueTokens({
      sub: user._id.toString(),
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
    });

    return { accessToken, refreshToken: newRefresh };
  }

  /* =========================
     LOGOUT
  ========================= */
  async logout(userId: string) {
    await this.usersService.removeRefreshToken(userId);
    this.logger.log(`Logout → ${userId}`);
  }

  /* =========================
     LOGOUT ALL DEVICES
  ========================= */
  async logoutAll(userId: string) {
    await this.usersService.incrementTokenVersion(userId);
    await this.usersService.removeRefreshToken(userId);
    this.logger.log(`All sessions revoked → ${userId}`);
  }

  /**
   * Extracts userId from a refresh token *without throwing* on invalid tokens.
   * Used by the logout endpoint — the user's intent is to log out, so we
   * honor that regardless of token state.
   */
  async getUserIdFromRefreshToken(token: string): Promise<string | null> {
    if (!token) return null;
    try {
      const payload = await this.jwtService.verifyAsync<SignedPayload>(token, {
        secret: this.refreshSecret,
        issuer: this.issuer,
        audience: this.audience,
        ignoreExpiration: true,
      });
      return payload?.sub ?? null;
    } catch {
      return null;
    }
  }

  /* =========================
     VERIFY OTP
  ========================= */
  async verifyOtp(dto: VerifyOtpDto, ip: string) {
    const email = this.normalizeEmail(dto.email);
    const user = await this.usersService.findByEmail(email);

    if (!user) throw new BadRequestException('Invalid request');

    await this.otpService.verifyOtp(user._id.toString(), dto.otp, dto.purpose);

    this.logger.log(`OTP verified → ${email} | IP: ${ip}`);

    return { message: 'OTP verified successfully' };
  }

  /* =========================
     FORGOT PASSWORD
  ========================= */
  async forgotPassword(email: string, ip?: string) {
    const normalized = this.normalizeEmail(email);
    const user = await this.usersService.findByEmail(normalized);

    // Always return the same message — prevents email enumeration.
    if (user && user.isActive) {
      try {
        await this.otpService.sendOtp(
          user._id.toString(),
          user.email,
          OtpPurpose.RESET_PASSWORD,
          { ip },
        );
      } catch (err) {
        this.logger.error(`OTP send failed for ${normalized}`, err as Error);
      }
    }

    return { message: 'If that email exists, an OTP has been sent.' };
  }

  /* =========================
     RESET PASSWORD
  ========================= */
  async resetPassword(dto: ResetPasswordDto) {
    const email = this.normalizeEmail(dto.email);
    const user = await this.usersService.findByEmail(email, true);

    if (!user) throw new BadRequestException('Invalid request');

    await this.otpService.verifyOtp(
      user._id.toString(),
      dto.otp,
      OtpPurpose.RESET_PASSWORD,
    );

    if (!this.isStrongPassword(dto.newPassword)) {
      throw new BadRequestException(
        'Password must be 8+ chars with uppercase, lowercase, number and symbol',
      );
    }

    // Reject reuse of the current password.
    if (user.password) {
      const samePassword = await bcrypt.compare(dto.newPassword, user.password);
      if (samePassword) {
        throw new BadRequestException(
          'New password must be different from the current password',
        );
      }
    }

    // forceSetPassword atomically: hashes the password, clears refreshToken,
    // and bumps tokenVersion — invalidating all existing sessions.
    await this.usersService.forceSetPassword(user._id.toString(), dto.newPassword);

    this.logger.log(`Password reset → ${email}`);

    return { message: 'Password reset successful' };
  }

  /* =========================
     TOKEN HELPERS
  ========================= */
  private async issueTokens(payload: JwtPayload): Promise<{
    accessToken: string;
    refreshToken: string;
  }> {
    const accessToken = await this.jwtService.signAsync(
      { ...payload, type: 'access' satisfies TokenType },
      {
        secret: this.accessSecret,
        expiresIn: this.accessTokenExpiry,
        issuer: this.issuer,
        audience: this.audience,
      },
    );

    const refreshToken = await this.jwtService.signAsync(
      { ...payload, type: 'refresh' satisfies TokenType },
      {
        secret: this.refreshSecret,
        expiresIn: this.refreshTokenExpiry,
        issuer: this.issuer,
        audience: this.audience,
      },
    );

    await this.usersService.setRefreshToken(
      payload.sub,
      await bcrypt.hash(refreshToken, REFRESH_TOKEN_HASH_ROUNDS),
    );

    return { accessToken, refreshToken };
  }

  /* =========================
     HELPERS
  ========================= */
  private isStrongPassword(password: string): boolean {
    return PASSWORD_REGEX.test(password);
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }
}
