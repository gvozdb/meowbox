import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Request } from 'express';
import { PrismaService } from '../prisma.service';
import { extractClientIp } from '../http/client-ip';
import { getOrCreateNetworkContext, NetworkContextRequest } from '../http/network-context';
import { isVerifiedFederationRequest } from '../../federation/federation-request-context';

const AUDITED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const FEDERATION_READ_AUDIT_SUPPRESS = new Set([
  '/api/dashboard/overview',
  '/api/dashboard/summary',
  '/api/system/metrics',
]);

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('AuditInterceptor');
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<{ statusCode: number }>();
    const requestState = req as Request & NetworkContextRequest & {
      proxyAuthenticated?: boolean;
    };
    const federation = isVerifiedFederationRequest(requestState)
      ? requestState.federationContext
      : null;

    if (
      !AUDITED_METHODS.has(req.method) &&
      (!federation || FEDERATION_READ_AUDIT_SUPPRESS.has(req.path))
    ) {
      return next.handle();
    }

    const user = (req as unknown as Record<string, unknown>).user as
      | { sub: string; role: string }
      | undefined;
    const startTime = Date.now();
    const network = getOrCreateNetworkContext(requestState);

    const writeLog = (status: 'SUCCESS' | 'FAILED', extra: Record<string, unknown>) => {
      if (!user?.sub) return;
      const path = req.route?.path || req.path;
      const action = this.resolveAction(req.method, path);
      const entity = this.resolveEntity(path);
      const entityId = req.params?.id || null;

      if (federation) {
        this.prisma.proxyAuditLog
          .create({
            data: {
              direction: 'IN',
              userId: federation.userId,
              serverId: null,
              serverName: null,
              method: req.method,
              path: req.path,
              statusCode: status === 'SUCCESS'
                ? response.statusCode
                : (extra.status as number | undefined) ?? 500,
              durationMs: Date.now() - startTime,
              ipAddress: network.peerIp,
              userAgent: (req.headers['user-agent'] || '').slice(0, 512),
              errorMsg: status === 'FAILED' ? `HTTP_${(extra.status as number | undefined) ?? 500}` : null,
              requestId: federation.requestId,
              actionId: federation.actionId,
              issuerInstallationId: federation.issuerInstallationId,
              targetInstallationId: federation.targetInstallationId,
              targetPrincipalId: federation.principalId,
              actorKind: federation.actorKind,
              keyId: federation.keyId,
              operationId: federation.operationId,
              peerIp: network.peerIp,
              browserIp: network.browserIp,
            },
          })
          .catch((err: unknown) => {
            this.logger.warn(`federation-audit IN write failed: ${(err as Error).message}`);
          });
        return;
      }

      // Proxy server-to-server вызовы имеют синтетического юзера (sub='proxy'),
      // у которого НЕТ записи в users. Пишем такие операции в отдельную таблицу
      // proxy_audit_logs с direction=IN (slave-сторона видит этот трафик
      // как входящий от чужой панели). Так есть полноценный журнал в БД,
      // а не warn в stdout.
      if (user.sub === 'proxy' || requestState.proxyAuthenticated === true) {
        this.prisma.proxyAuditLog
          .create({
            data: {
              direction: 'IN',
              userId: null,
              serverId: null,
              serverName: null,
              method: req.method,
              path: req.path,
              statusCode: status === 'SUCCESS' ? 200 : (extra.status as number | undefined) ?? 500,
              durationMs: Date.now() - startTime,
              ipAddress: network.peerIp,
              peerIp: network.peerIp,
              browserIp: network.browserIp,
              userAgent: (req.headers['user-agent'] || '').slice(0, 512),
              errorMsg: status === 'FAILED' ? String(extra.error ?? '').slice(0, 1000) : null,
            },
          })
          .catch((err: unknown) => {
            this.logger.warn(`proxy-audit IN write failed: ${(err as Error).message}`);
          });
        return;
      }

      this.prisma.auditLog
        .create({
          data: {
            userId: user.sub,
            action,
            entity,
            entityId,
            details: JSON.stringify({
              method: req.method,
              path: req.path,
              status,
              durationMs: Date.now() - startTime,
              ...extra,
            }),
            ipAddress: network.browserIp,
            userAgent: (req.headers['user-agent'] || '').slice(0, 512),
          },
        })
        .catch(() => {
          // Audit log failure should never break the request
        });
    };

    return next.handle().pipe(
      tap({
        next: () => writeLog('SUCCESS', {}),
        error: (err: unknown) => {
          // Теперь в логах остаётся след провалившихся операций — раньше
          // tap(() => …) ловил только SUCCESS, и все 403/500 проходили мимо.
          const e = err as { status?: number; message?: string };
          writeLog('FAILED', {
            status: e?.status ?? 500,
            error: String(e?.message ?? err).slice(0, 1000),
          });
        },
      }),
    );
  }

  private resolveAction(
    method: string,
    path: string,
  ): 'CREATE' | 'UPDATE' | 'DELETE' | 'LOGIN' | 'LOGOUT' | 'DEPLOY' | 'BACKUP' | 'RESTORE' | 'SSL_ISSUE' | 'SERVICE_START' | 'SERVICE_STOP' | 'SERVICE_RESTART' {
    if (path.includes('/auth/login')) return 'LOGIN';
    if (path.includes('/auth/logout')) return 'LOGOUT';
    if (path.includes('/deploy')) return 'DEPLOY';
    if (path.includes('/backup') && method === 'POST') return 'BACKUP';
    if (path.includes('/restore')) return 'RESTORE';
    if (path.includes('/ssl/issue')) return 'SSL_ISSUE';
    if (path.includes('/start')) return 'SERVICE_START';
    if (path.includes('/stop')) return 'SERVICE_STOP';
    if (path.includes('/restart')) return 'SERVICE_RESTART';
    if (method === 'POST') return 'CREATE';
    if (method === 'PUT' || method === 'PATCH') return 'UPDATE';
    if (method === 'DELETE') return 'DELETE';
    return 'CREATE';
  }

  private resolveEntity(path: string): string {
    // Extract entity from path: /api/sites/:id -> sites
    const segments = path.replace(/^\/api\//, '').split('/');
    return segments[0] || 'unknown';
  }

  private extractIp(req: Request): string {
    return extractClientIp(req);
  }
}
