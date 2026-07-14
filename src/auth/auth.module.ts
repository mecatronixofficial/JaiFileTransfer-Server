import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';

import { UsersModule } from '../users/users.module';
import { OtpModule } from '../otp/otp.module';

@Module({
  imports: [
    ConfigModule,

    /* =========================
       PASSPORT JWT
    ========================= */
    PassportModule.register({
      defaultStrategy: 'jwt',
      session: false,
    }),

    /* =========================
       JWT CONFIG (SAFE + CLEAN)
    ========================= */
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const accessSecret =
          configService.get<string>('jwt.accessSecret') ??
          configService.get<string>('jwt.secret');

        if (!accessSecret) {
          throw new Error('JWT secret is not configured');
        }

        return {
          secret: accessSecret,
          signOptions: {
            expiresIn: configService.get<string>('jwt.expiresIn') ?? '1d',
            issuer: configService.get<string>('jwt.issuer') ?? 'jai-india-api',
            audience: configService.get<string>('jwt.audience') ?? 'jai-india-users',
          },
        };
      },
    }),

    /* =========================
       FEATURE MODULES
    ========================= */
    forwardRef(() => UsersModule),
    forwardRef(() => OtpModule),
  ],

  controllers: [AuthController],

  providers: [AuthService, JwtStrategy],

  exports: [
    AuthService,
    JwtModule, // needed for signing/verifying tokens elsewhere
  ],
})
export class AuthModule {}
