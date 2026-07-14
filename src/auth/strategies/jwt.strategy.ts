import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { UsersService } from '../../users/users.service';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  tokenVersion: number;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
    // Must use the same secret that AuthService uses to sign access tokens.
    // AuthService uses jwt.accessSecret with fallback to jwt.secret.
    const accessSecret =
      configService.get<string>('jwt.accessSecret') ??
      configService.get<string>('jwt.secret');

    if (!accessSecret) {
      throw new Error('JWT access secret is missing in environment variables');
    }

    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        JwtStrategy.extractJwtFromCookie,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      secretOrKey: accessSecret,
      issuer: configService.get<string>('jwt.issuer') ?? 'jai-india-api',
      audience: configService.get<string>('jwt.audience') ?? 'jai-india-users',
      ignoreExpiration: false,
      passReqToCallback: false,
    });

  }

  /* =========================
     COOKIE EXTRACTOR
  ========================= */
  private static extractJwtFromCookie(req: Request): string | null {
    if (!req?.cookies) return null;
    return (
      req.cookies.access_token ??
      req.cookies.accessToken ??
      req.cookies.jwt ??
      null
    );
  }

  /* =========================
     VALIDATE
  ========================= */
  async validate(payload: JwtPayload) {
    if (!payload?.sub || !payload.email) {
      throw new UnauthorizedException('Invalid token payload');
    }

    const user = await this.usersService
      .findAuthUserById(payload.sub)
      .catch(() => null);

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account disabled');
    }

    if (user.tokenVersion !== payload.tokenVersion) {
      throw new UnauthorizedException('Token expired');
    }

    if (user.email !== payload.email) {
      throw new UnauthorizedException('Token mismatch');
    }

    if (user.role !== payload.role) {
      throw new UnauthorizedException('Role mismatch');
    }

    return {
      _id: user._id.toString(),
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      tokenVersion: user.tokenVersion,
      organizationId: user.organizationId ?? null,
    };
  }
}
