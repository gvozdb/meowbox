/**
 * IpAllowlistGuard — фильтрует IP клиента до любых auth-эндпоинтов.
 * Регистрируется в `app.module` ПЕРВЫМ из APP_GUARD'ов, чтобы:
 *   - даже /auth/login не был доступен с IP вне списка (защита от подбора)
 *   - сворованный refresh-токен не работал из роуминга
 *
 * Bypass:
 *   1. Loopback (127.x, ::1) — всегда (escape-hatch через SSH-туннель).
 *   2. Cryptographically verified federation or one-use enrollment context.
 *      Paths and headers alone never bypass the allowlist.
 *
 * Источник IP — `req.ip`. Express берёт его из X-Forwarded-For, если в
 * `main.ts` выставлен `trust proxy` (для nginx-loopback). Без trust-proxy
 * IP всегда будет 127.0.0.1 → bypass всегда → allowlist бесполезен.
 */
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';

import { IpAllowlistService } from './ip-allowlist.service';
import { isVerifiedFederationRequest } from '../federation/federation-request-context';
import { getOrCreateNetworkContext } from '../common/http/network-context';

interface RequestLike {
  ip?: string;
  url?: string;
  originalUrl?: string;
  socket?: { remoteAddress?: string };
  headers: Record<string, string | string[] | undefined>;
  federationBootstrapContext?: { verified?: boolean };
}

@Injectable()
export class IpAllowlistGuard implements CanActivate {
  private readonly logger = new Logger('IpAllowlistGuard');

  constructor(private readonly service: IpAllowlistService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestLike>();
    const url = req.originalUrl || req.url || '';
    if (
      isVerifiedFederationRequest(req) ||
      req.federationBootstrapContext?.verified === true
    ) return true;

    const cfg = this.service.getConfig();
    if (!cfg.enabled) return true;

    const ip = getOrCreateNetworkContext(req).browserIp;
    if (this.service.isAllowed(ip)) return true;

    this.logger.warn(`IP allowlist: blocked ${ip} → ${url}`);
    throw new ForbiddenException(
      `Доступ запрещён: ваш IP (${ip || 'unknown'}) не в whitelist'е панели`,
    );
  }

  private extractIp(req: RequestLike): string {
    // express c trust proxy уже подставит правильный req.ip.
    if (req.ip) return req.ip;
    return req.socket?.remoteAddress || '';
  }
}
