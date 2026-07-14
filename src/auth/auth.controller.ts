import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Patch,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { CookieOptions, Request, Response } from 'express';

import { AuthService } from './auth.service';
import {
  ForgotPasswordDto,
  LoginDto,
  RequestOtpDto,
  ResendOtpDto,
  ResetPasswordDto,
  VerifyOtpDto,
  VerifyTwoFactorLoginDto,
  UpdateTwoFactorDto,
  DeleteOwnAccountDto,
} from './dto/auth.dto';

import { JwtAuthGuard, Public } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ClientIp } from '../common/decorators/client-ip.decorator';
import { OtpService } from '../otp/otp.service';
import { UsersService } from '../users/users.service';
import { OtpPurpose } from '../common/enums';

const ACCESS_COOKIE = 'access_token';
const REFRESH_COOKIE = 'refresh_token';
const DEFAULT_ACCESS_TOKEN_EXPIRY = '1d';
const DEFAULT_REFRESH_TOKEN_EXPIRY = '30d';

interface AuthUser {
  _id: string;
  email: string;
  role: string;
  isActive: boolean;
  tokenVersion: number;
  organizationId: string | null;
}

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  private readonly isProd: boolean;
  private readonly accessCookieMaxAge: number;
  private readonly refreshCookieMaxAge: number;

  constructor(
    private readonly authService: AuthService,
    private readonly otpService: OtpService,
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
  ) {
    this.isProd = this.configService.get<string>('app.env') === 'production';
    this.accessCookieMaxAge = this.durationToMs(
      this.configService.get<string>('jwt.accessTokenExpiry') ?? DEFAULT_ACCESS_TOKEN_EXPIRY,
    );
    this.refreshCookieMaxAge = this.durationToMs(
      this.configService.get<string>('jwt.refreshTokenExpiry') ?? DEFAULT_REFRESH_TOKEN_EXPIRY,
    );
  }

  /* =========================
     COOKIE HELPERS
  ========================= */
  private getCookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.isProd,
      sameSite: this.isProd ? 'none' : 'lax',
      path: '/',
    };
  }

  private setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
    const base = this.getCookieOptions();
    res.cookie(ACCESS_COOKIE, accessToken, { ...base, maxAge: this.accessCookieMaxAge });
    res.cookie(REFRESH_COOKIE, refreshToken, { ...base, maxAge: this.refreshCookieMaxAge });
  }

  private clearAuthCookies(res: Response): void {
    const base = this.getCookieOptions();
    res.clearCookie(ACCESS_COOKIE, base);
    res.clearCookie(REFRESH_COOKIE, base);
  }

  private durationToMs(value: string): number {
    const match = value.trim().match(/^(\d+)\s*(ms|s|m|h|d)$/i);
    if (!match) return 1000 * 60 * 60 * 24;

    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multipliers: Record<string, number> = {
      ms: 1,
      s: 1000,
      m: 1000 * 60,
      h: 1000 * 60 * 60,
      d: 1000 * 60 * 60 * 24,
    };

    return amount * multipliers[unit];
  }

  /* =========================
     LOGIN
  ========================= */
  @Post('login')
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @ClientIp() ip: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const userAgent = req.headers['user-agent'];
    const result = await this.authService.login(dto, ip, userAgent);

    if (result.requiresTwoFactor) {
      return {
        message: 'Two-factor verification required',
        data: { requiresTwoFactor: true, email: result.email },
      };
    }

    this.setAuthCookies(res, result.accessToken, result.refreshToken);

    return {
      message: 'Login successful',
      data: { requiresTwoFactor: false, user: result.user },
    };
  }

  @Post('verify-two-factor')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async verifyTwoFactorLogin(
    @Body() dto: VerifyTwoFactorLoginDto,
    @ClientIp() ip: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.verifyTwoFactorLogin(
      dto,
      ip,
      req.headers['user-agent'],
    );
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    return { message: 'Login successful', data: { user: result.user } };
  }

  /* =========================
     REFRESH
  ========================= */
  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies?.[REFRESH_COOKIE];

    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token missing');
    }

    const result = await this.authService.refresh(refreshToken);

    this.setAuthCookies(res, result.accessToken, result.refreshToken);

    return { message: 'Token refreshed successfully' };
  }

  /* =========================
     LOGOUT
     Public — works even with expired/missing tokens.
     Idempotent — calling logout when already logged out returns 200.
  ========================= */
  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies?.[REFRESH_COOKIE];

    if (refreshToken) {
      try {
        const userId = await this.authService.getUserIdFromRefreshToken(refreshToken);
        if (userId) {
          await this.authService.logout(userId);
        }
      } catch (err) {
        if (!this.isProd) {
          this.logger.debug(`Logout token revoke skipped: ${String(err)}`);
        }
      }
    }

    this.clearAuthCookies(res);

    return { message: 'Logged out successfully' };
  }

  /* =========================
     LOGOUT ALL DEVICES
     Bumps tokenVersion to invalidate every issued JWT for this user.
  ========================= */
  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async logoutAll(
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.logoutAll(user._id);
    this.clearAuthCookies(res);
    return { message: 'All sessions revoked successfully' };
  }

  /* =========================
     ME
  ========================= */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: AuthUser): Promise<any> {
    const fullUser = await this.usersService.findById(user._id);
    return { message: 'User retrieved successfully', data: fullUser };
  }

  @Patch('two-factor/enable')
  @UseGuards(JwtAuthGuard)
  async enableTwoFactor(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateTwoFactorDto,
  ) {
    const data = await this.authService.updateTwoFactor(user._id, dto.otp, true);
    return { message: 'Two-factor authentication enabled', data };
  }

  @Patch('two-factor/disable')
  @UseGuards(JwtAuthGuard)
  async disableTwoFactor(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateTwoFactorDto,
  ) {
    const data = await this.authService.updateTwoFactor(user._id, dto.otp, false);
    return { message: 'Two-factor authentication disabled', data };
  }

  @Delete('account')
  @UseGuards(JwtAuthGuard)
  async deleteOwnAccount(
    @CurrentUser() user: AuthUser,
    @Body() dto: DeleteOwnAccountDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.deleteOwnAccount(user._id, dto.otp);
    this.clearAuthCookies(res);
    return result;
  }

  /* =========================
     VERIFY OTP
  ========================= */
  @Post('verify-otp')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async verifyOtp(@Body() dto: VerifyOtpDto, @ClientIp() ip: string) {
    await this.authService.verifyOtp(dto, ip);
    return { message: 'OTP verified successfully' };
  }

  /* =========================
     RESEND OTP
  ========================= */
  @Post('resend-otp')
  @Public()
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async resendOtp(
    @Body() dto: ResendOtpDto,
    @ClientIp() ip: string,
    @Req() req: Request,
  ) {
    const email = dto.email.toLowerCase();
    const user = await this.usersService.findByEmail(email);

    if (user) {
      await this.otpService.sendOtp(
        user._id.toString(),
        user.email,
        dto.purpose ?? OtpPurpose.RESET_PASSWORD,
        { ip, userAgent: req.headers['user-agent'] },
      );
    }

    return { message: 'If that email exists, an OTP has been resent.' };
  }

  /* =========================
     REQUEST OTP
  ========================= */
  @Post('request-otp')
  @UseGuards(JwtAuthGuard)
  async requestOtp(
    @Body() dto: RequestOtpDto,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string,
    @Req() req: Request,
  ) {
    const result = await this.otpService.sendOtp(
      user._id,
      user.email,
      dto.purpose,
      {
        fileId: dto.fileId,
        ip,
        userAgent: req.headers['user-agent'],
      },
    );

    return { message: result.message };
  }

  /* =========================
     FORGOT PASSWORD
  ========================= */
  @Post('forgot-password')
  @Public()
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async forgotPassword(@Body() dto: ForgotPasswordDto, @ClientIp() ip: string) {
    const result = await this.authService.forgotPassword(dto.email.toLowerCase(), ip);
    return { message: result.message };
  }

  /* =========================
     RESET PASSWORD
  ========================= */
  @Post('reset-password')
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    const result = await this.authService.resetPassword(dto);
    return { message: result.message };
  }
}
