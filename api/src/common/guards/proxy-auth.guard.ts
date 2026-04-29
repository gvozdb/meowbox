import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Allows requests authenticated with X-Proxy-Token header.
 * This guard runs BEFORE the JWT guard. If a valid proxy token is present,
 * it sets a synthetic admin user on the request so JWT guard passes.
 *
 * На серверах без PROXY_TOKEN любой X-Proxy-Token игнорируется (no-op).
 * Если PROXY_TOKEN задан и X-Proxy-Token передан — токен обязан совпадать,
 * иначе 401 (fail-closed). Ранее при невалидном токене guard пропускал
 * запрос дальше, надеясь на JWT — это потенциальный fail-open.
 */
@Injectable()
export class ProxyAuthGuard implements CanActivate {
  private readonly logger = new Logger(ProxyAuthGuard.name);
  private readonly proxyToken: string | null;

  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {
    this.proxyToken = this.config.get<string>('PROXY_TOKEN', '') || null;
  }

  canActivate(context: ExecutionContext): boolean {
    // Skip for public routes
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: unknown;
      ip?: string;
    }>();

    const token = req.headers['x-proxy-token'];

    // Без конфига PROXY_TOKEN любой X-Proxy-Token должен быть проигнорирован —
    // но также и никогда не принят как valid. Если вдруг кто-то прислал такой
    // заголовок — это подозрительно, логируем и отбиваем.
    if (!this.proxyToken) {
      if (token) {
        this.logger.warn(
          `X-Proxy-Token received but PROXY_TOKEN is not configured (ip=${req.ip ?? 'unknown'})`,
        );
        throw new UnauthorizedException('Proxy token not configured on this server');
      }
      return true;
    }

    if (!token) return true; // Let JWT guard handle it

    // Constant-time comparison
    if (this.constantTimeCompare(token, this.proxyToken)) {
      // Set synthetic admin user so JWT guard and roles guard pass
      req.user = {
        sub: 'proxy',
        username: 'proxy',
        role: 'ADMIN',
      };
      return true;
    }

    // Невалидный токен — активно отбиваем. Нельзя пропускать на JWT:
    // JWT мог быть подделан с другим секретом, но PROXY_TOKEN — это отдельный
    // server-to-server бандл, и неправильный токен = атака.
    this.logger.warn(
      `Invalid X-Proxy-Token rejected (ip=${req.ip ?? 'unknown'})`,
    );
    throw new UnauthorizedException('Invalid proxy token');
  }

  private constantTimeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch {
      return false;
    }
  }
}
