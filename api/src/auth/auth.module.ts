import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { SetupController } from './setup.controller';
import { JwtStrategy } from './jwt.strategy';
import { SessionService } from './session.service';
import { BasicAuthService } from './basic-auth.service';
import { BasicAuthController } from './basic-auth.controller';
import { BasicAuthInternalController } from './basic-auth-internal.controller';
import { UsersModule } from '../users/users.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    UsersModule,
    NotificationsModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        signOptions: {
          expiresIn: config.get('JWT_ACCESS_EXPIRES_IN', '15m'),
        },
      }),
    }),
  ],
  controllers: [AuthController, SetupController, BasicAuthController, BasicAuthInternalController],
  providers: [AuthService, JwtStrategy, SessionService, BasicAuthService],
  exports: [AuthService, SessionService, BasicAuthService],
})
export class AuthModule {}
