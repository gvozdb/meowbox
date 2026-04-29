import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { hashPassword, verifyPassword } from '../common/crypto/argon2.helper';
import { UsersService } from '../users/users.service';
import { SessionService } from './session.service';
import { NotificationDispatcherService } from '../notifications/notification-dispatcher.service';

interface JwtPayload {
  sub: string;
  username: string;
  role: string;
  jti: string; // Unique token ID for blacklisting
}

// Лимиты конфигурируются через env, чтобы можно было ужесточить без релиза.
const MAX_LOGIN_ATTEMPTS = Number(process.env.AUTH_MAX_LOGIN_ATTEMPTS) || 10;
const MAX_USERNAME_ATTEMPTS = Number(process.env.AUTH_MAX_USERNAME_ATTEMPTS) || 20;
const LOGIN_ALERT_THRESHOLD = Number(process.env.AUTH_LOGIN_ALERT_THRESHOLD) || 5;
const REFRESH_TOKEN_TTL_SECONDS =
  Number(process.env.AUTH_REFRESH_TTL_SECONDS) || 7 * 24 * 60 * 60; // 7 days
// Grace-период для конкурентного refresh: если старый токен был занесён в
// blacklist НЕ БОЛЬШЕ этого количества миллисекунд назад — считаем попытку
// не атакой, а гонкой (несколько вкладок/запросов после pm2 restart пришли
// одновременно, первый ротировал, остальные не знают и приходят со старым).
// В таком случае вместо 403 «Token revoked» выдаём свежую пару токенов.
// Конфигурируется через env, чтобы можно было занижать на чувствительных
// инсталляциях (банкинг/админка в сети tier-0) без релиза.
const REFRESH_RACE_GRACE_MS = Number(process.env.AUTH_REFRESH_GRACE_MS) || 15_000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly sessionService: SessionService,
    private readonly notificationDispatcher: NotificationDispatcherService,
  ) {}

  async login(username: string, password: string, ip: string, userAgent = '') {
    // Brute-force protection: пара счётчиков per-IP + per-username.
    // Per-IP отсекает атаки с одного адреса; per-username — распределённый
    // спрей (ботнет, миллион IP, один логин). Достаточно перелимита в любом
    // из двух, чтобы войти стало невозможно.
    const [ipAttempts, userAttempts] = await Promise.all([
      this.sessionService.getLoginAttempts(ip),
      this.sessionService.getUsernameAttempts(username),
    ]);
    if (ipAttempts >= MAX_LOGIN_ATTEMPTS) {
      throw new ForbiddenException(
        'Too many login attempts from this IP. Try again in 15 minutes.',
      );
    }
    if (userAttempts >= MAX_USERNAME_ATTEMPTS) {
      throw new ForbiddenException(
        'Too many failed login attempts for this username. Try again in 15 minutes.',
      );
    }

    const user = await this.usersService.findByUsername(username);

    if (!user) {
      // Constant-time delay to prevent username enumeration
      await hashPassword('dummy-password-for-timing');
      const [ipCount] = await Promise.all([
        this.sessionService.incrementLoginAttempts(ip),
        this.sessionService.incrementUsernameAttempts(username),
      ]);
      this.checkLoginAlertThreshold(ipCount, ip, username);
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await verifyPassword(user.passwordHash, password);
    if (!isPasswordValid) {
      const [ipCount] = await Promise.all([
        this.sessionService.incrementLoginAttempts(ip),
        this.sessionService.incrementUsernameAttempts(username),
      ]);
      this.checkLoginAlertThreshold(ipCount, ip, username);
      throw new UnauthorizedException('Invalid credentials');
    }

    // Successful login — reset attempts (both IP and username)
    await Promise.all([
      this.sessionService.resetLoginAttempts(ip),
      this.sessionService.resetUsernameAttempts(username),
    ]);

    const tokens = await this.generateTokenPair(
      { sub: user.id, username: user.username, role: user.role },
      ip,
      userAgent,
    );

    this.logger.log(`User ${user.username} logged in from ${ip}`);

    return {
      ...tokens,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        totpEnabled: user.totpEnabled,
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
      },
    };
  }

  async refreshTokens(refreshToken: string, ip: string, userAgent = '') {
    let payload: JwtPayload;

    try {
      payload = this.jwtService.verify<JwtPayload>(refreshToken, {
        secret: this.configService.getOrThrow('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new ForbiddenException('Invalid or expired refresh token');
    }

    // Check if token is blacklisted (already rotated)
    if (payload.jti && (await this.sessionService.isTokenBlacklisted(payload.jti))) {
      // Если токен был отозван совсем недавно (<15с) — это не атака, а
      // конкурентный refresh (несколько вкладок / перезагрузок страницы
      // бьют в /auth/refresh одним и тем же токеном после pm2 restart).
      // В этой ветке выдаём СВЕЖУЮ пару токенов — юзер не выкидывается на логин,
      // сессия продолжает жить.
      const raceOk = await this.sessionService.wasBlacklistedRecently(
        payload.jti,
        REFRESH_RACE_GRACE_MS,
      );
      if (raceOk) {
        this.logger.log(
          `Refresh race resolved (grace=${REFRESH_RACE_GRACE_MS}ms) for user ${payload.sub} from IP ${ip}`,
        );
        const user = await this.usersService.findById(payload.sub);
        if (!user) {
          throw new ForbiddenException('User not found');
        }
        return this.generateTokenPair(
          { sub: user.id, username: user.username, role: user.role },
          ip,
          userAgent,
        );
      }
      // Настоящий reuse — возможно, украли токен и используют с другой машины.
      this.logger.warn(
        `Refresh token reuse detected for user ${payload.sub} from IP ${ip}`,
      );
      throw new ForbiddenException('Token has been revoked');
    }

    // IP binding check
    if (payload.jti) {
      const meta = await this.sessionService.getSessionMeta(payload.jti);
      if (meta && meta.ip !== ip) {
        this.logger.warn(
          `IP mismatch for refresh token of user ${payload.sub}: stored=${meta.ip}, current=${ip}`,
        );
        // Blacklist the old token
        await this.sessionService.blacklistToken(payload.jti, REFRESH_TOKEN_TTL_SECONDS);
        await this.sessionService.removeSession(payload.jti);
        throw new ForbiddenException(
          'Session invalidated due to IP change. Please log in again.',
        );
      }
    }

    const user = await this.usersService.findById(payload.sub);
    if (!user) {
      throw new ForbiddenException('User not found');
    }

    // Rotate: blacklist old token, issue new pair
    if (payload.jti) {
      await this.sessionService.blacklistToken(payload.jti, REFRESH_TOKEN_TTL_SECONDS);
      await this.sessionService.removeSession(payload.jti);
    }

    return this.generateTokenPair(
      { sub: user.id, username: user.username, role: user.role },
      ip,
      userAgent,
    );
  }

  async logout(refreshToken: string) {
    try {
      const payload = this.jwtService.verify<JwtPayload>(refreshToken, {
        secret: this.configService.getOrThrow('JWT_REFRESH_SECRET'),
      });

      if (payload.jti) {
        await this.sessionService.blacklistToken(payload.jti, REFRESH_TOKEN_TTL_SECONDS);
        await this.sessionService.removeSession(payload.jti);
      }
    } catch {
      // Token already expired or invalid — still a successful logout
    }
  }

  // ===========================================================================
  // Session management
  // ===========================================================================

  async getSessions(userId: string) {
    return this.sessionService.getUserSessions(userId);
  }

  async revokeSession(_userId: string, sessionId: string) {
    await this.sessionService.blacklistToken(sessionId, REFRESH_TOKEN_TTL_SECONDS);
    await this.sessionService.removeSession(sessionId);
  }

  async revokeAllSessions(userId: string, currentJti?: string) {
    const revoked = await this.sessionService.removeAllUserSessions(userId, currentJti);
    for (const jti of revoked) {
      await this.sessionService.blacklistToken(jti, REFRESH_TOKEN_TTL_SECONDS);
    }
    return { revoked: revoked.length };
  }

  async getProfile(userId: string) {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      totpEnabled: user.totpEnabled,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }

  // ===========================================================================
  // Profile update (self-service)
  // ===========================================================================

  async updateProfile(
    userId: string,
    data: { email?: string; password?: string; currentPassword?: string },
  ) {
    const wantsChange = !!(data.email || data.password);
    if (!wantsChange) {
      // Ничего не меняем — вернём текущий профиль.
      const u = await this.usersService.findById(userId);
      if (!u) throw new UnauthorizedException('User not found');
      return {
        id: u.id,
        username: u.username,
        email: u.email,
        role: u.role,
        totpEnabled: u.totpEnabled,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
      };
    }

    // Обязательная ре-аутентификация текущим паролем: украденный access-token
    // больше не позволяет перехватить аккаунт через PUT /auth/me.
    if (!data.currentPassword) {
      throw new UnauthorizedException('Current password is required');
    }
    await this.usersService.verifyPassword(userId, data.currentPassword);

    const updateData: { email?: string; password?: string } = {};
    if (data.email) updateData.email = data.email;
    if (data.password) updateData.password = data.password;

    const updated = await this.usersService.update(userId, updateData);
    return {
      id: updated.id,
      username: updated.username,
      email: updated.email,
      role: updated.role,
      totpEnabled: updated.totpEnabled,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  // ===========================================================================
  // Login failure alert
  // ===========================================================================

  private checkLoginAlertThreshold(count: number, ip: string, username: string): void {
    if (count === LOGIN_ALERT_THRESHOLD) {
      this.notificationDispatcher
        .dispatch({
          event: 'LOGIN_FAILED',
          title: 'Suspicious Login Activity',
          message: `${count} failed login attempts for user "${username}" from IP ${ip}.`,
          timestamp: new Date(),
        })
        .catch((err) => {
          this.logger.error(`Failed to send login alert: ${(err as Error).message}`);
        });
    }
  }

  // ===========================================================================
  // 2FA (TOTP)
  // ===========================================================================

  async enableTotp(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await this.usersService.findById(userId);
    if (!user) throw new UnauthorizedException('User not found');

    if (user.totpEnabled) {
      throw new ForbiddenException('2FA is already enabled');
    }

    // 32 bytes = 256 бит энтропии. RFC 6238 требует минимум 160 бит, но 256
    // — сегодняшний стандарт де-факто. Храним в hex — HMAC ниже тоже hex-пара.
    const secret = crypto.randomBytes(32).toString('hex');

    // Store secret (not yet enabled)
    await this.usersService.updateTotpSecret(userId, secret);

    const issuer = 'Meowbox';
    const otpauthUrl = `otpauth://totp/${issuer}:${user.username}?secret=${secret}&issuer=${issuer}&digits=6&period=30`;

    return { secret, otpauthUrl };
  }

  async confirmTotp(userId: string, code: string): Promise<boolean> {
    const user = await this.usersService.findById(userId);
    if (!user || !user.totpSecret) {
      throw new ForbiddenException('TOTP not initialized');
    }

    if (!this.verifyTotpCode(user.totpSecret, code)) {
      throw new ForbiddenException('Invalid TOTP code');
    }

    await this.usersService.enableTotp(userId);
    return true;
  }

  async disableTotp(userId: string, code: string, currentPassword: string): Promise<boolean> {
    const user = await this.usersService.findById(userId);
    if (!user || !user.totpEnabled || !user.totpSecret) {
      throw new ForbiddenException('2FA is not enabled');
    }

    // Требуем подтверждение паролем — иначе украденный access-token позволил
    // бы атакующему выключить 2FA без знания пароля (game over).
    const passwordOk = await verifyPassword(user.passwordHash, currentPassword);
    if (!passwordOk) {
      throw new ForbiddenException('Invalid password');
    }

    if (!this.verifyTotpCode(user.totpSecret, code)) {
      throw new ForbiddenException('Invalid TOTP code');
    }

    await this.usersService.disableTotp(userId);
    return true;
  }

  private verifyTotpCode(secret: string, code: string): boolean {
    // Check current and +/- 1 time step to account for clock drift
    const period = 30;
    const now = Math.floor(Date.now() / 1000);

    for (const offset of [-1, 0, 1]) {
      const timeStep = Math.floor((now + offset * period) / period);
      const expected = this.generateTotpCode(secret, timeStep);
      // Constant-time comparison
      if (expected.length === code.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) {
        return true;
      }
    }

    return false;
  }

  private generateTotpCode(secret: string, timeStep: number): string {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(timeStep));

    const hmac = crypto.createHmac('sha1', Buffer.from(secret, 'hex'));
    hmac.update(buf);
    const hash = hmac.digest();

    const offset = hash[hash.length - 1] & 0x0f;
    const binary =
      ((hash[offset] & 0x7f) << 24) |
      ((hash[offset + 1] & 0xff) << 16) |
      ((hash[offset + 2] & 0xff) << 8) |
      (hash[offset + 3] & 0xff);

    const otp = binary % 1000000;
    return otp.toString().padStart(6, '0');
  }

  // ===========================================================================
  // Token generation
  // ===========================================================================

  private async generateTokenPair(
    user: { sub: string; username: string; role: string },
    ip: string,
    userAgent = '',
  ) {
    const jti = crypto.randomUUID();

    const accessPayload = { ...user, jti: crypto.randomUUID(), sid: jti };
    const refreshPayload: JwtPayload = { ...user, jti };

    const accessToken = this.jwtService.sign(accessPayload);

    const refreshToken = this.jwtService.sign(refreshPayload, {
      secret: this.configService.getOrThrow('JWT_REFRESH_SECRET'),
      expiresIn: this.configService.get('JWT_REFRESH_EXPIRES_IN', '7d'),
    });

    // Сохраняем сессию (IP-binding + список активных сессий для UI)
    await this.sessionService.addSession(
      jti,
      user.sub,
      ip,
      userAgent,
      REFRESH_TOKEN_TTL_SECONDS,
    );

    // Дедупликация: убираем старые сессии того же юзера с того же IP+UA.
    // В UI «Активные сессии» раньше копилось по записи на каждый pm2 restart
    // (конкурентные refresh → grace-фолбэк → новая сессия + старая живёт).
    // Теперь в любой момент на один девайс — одна запись сессии.
    const dupes = await this.sessionService.dedupeSessions(user.sub, ip, userAgent, jti);
    for (const oldJti of dupes) {
      await this.sessionService.blacklistToken(oldJti, REFRESH_TOKEN_TTL_SECONDS);
    }

    return { accessToken, refreshToken };
  }
}
