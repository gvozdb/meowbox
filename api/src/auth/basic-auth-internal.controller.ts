import { Controller, Get, Post, Body, Headers, UnauthorizedException } from '@nestjs/common';
import { IsString } from 'class-validator';
import { timingSafeEqual } from 'crypto';
import { Public } from '../common/decorators/public.decorator';
import { BasicAuthService } from './basic-auth.service';
import { ConfigService } from '@nestjs/config';

class VerifyDto {
  @IsString() username!: string;
  @IsString() password!: string;
}

/**
 * Внутренние эндпоинты для Nuxt server-middleware (Basic Auth).
 * Защищены заголовком `X-Internal-Token` (env INTERNAL_TOKEN или AGENT_SECRET).
 *
 *   GET  /api/internal/basic-auth         → { enabled, username }
 *   POST /api/internal/basic-auth/verify  → { ok: boolean }
 *
 * Хэш пароля не утекает наружу — верификация происходит на стороне API.
 */
@Controller('internal/basic-auth')
export class BasicAuthInternalController {
  constructor(
    private readonly service: BasicAuthService,
    private readonly config: ConfigService,
  ) {}

  private checkToken(token?: string) {
    // Отдельный секрет INTERNAL_TOKEN строго обязателен. Раньше был fallback
    // на AGENT_SECRET — это склеивало две поверхности атаки: утечка секрета
    // агента автоматически давала доступ к Basic-Auth verify/settings.
    // Если INTERNAL_TOKEN не задан, internal-эндпоинты просто закрыты.
    const internalToken = this.config.get<string>('INTERNAL_TOKEN');
    const agentSecret = this.config.get<string>('AGENT_SECRET');
    if (!internalToken) {
      throw new UnauthorizedException('INTERNAL_TOKEN is not configured');
    }
    if (internalToken === agentSecret) {
      // Защита от конфигурационной ошибки — операционно критично.
      throw new UnauthorizedException(
        'INTERNAL_TOKEN must be different from AGENT_SECRET',
      );
    }
    if (!token) {
      throw new UnauthorizedException();
    }
    // Constant-time сравнение: строковое `!==` может утечь длину префикса.
    const a = Buffer.from(token);
    const b = Buffer.from(internalToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException();
    }
  }

  @Get()
  @Public()
  async get(@Headers('x-internal-token') token?: string) {
    this.checkToken(token);
    return this.service.getConfig(); // только { enabled, username }, без хэша
  }

  @Post('verify')
  @Public()
  async verify(
    @Body() dto: VerifyDto,
    @Headers('x-internal-token') token?: string,
  ) {
    this.checkToken(token);
    const ok = await this.service.verify(dto.username, dto.password);
    return { ok };
  }
}
