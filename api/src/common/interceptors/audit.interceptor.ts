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

const AUDITED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('AuditInterceptor');
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();

    if (!AUDITED_METHODS.has(req.method)) {
      return next.handle();
    }

    const user = (req as unknown as Record<string, unknown>).user as
      | { sub: string; role: string }
      | undefined;
    const startTime = Date.now();

    const writeLog = (status: 'SUCCESS' | 'FAILED', extra: Record<string, unknown>) => {
      if (!user?.sub) return;
      const path = req.route?.path || req.path;
      const action = this.resolveAction(req.method, path);
      const entity = this.resolveEntity(path);
      const entityId = req.params?.id || null;

      // Proxy server-to-server вызовы имеют синтетического юзера (sub='proxy'),
      // у которого НЕТ записи в users. Пишем такие операции в отдельную таблицу
      // proxy_audit_logs с direction=IN (slave-сторона видит этот трафик
      // как входящий от чужой панели). Так есть полноценный журнал в БД,
      // а не warn в stdout.
      if (user.sub === 'proxy') {
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
              ipAddress: this.extractIp(req),
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
            ipAddress: this.extractIp(req),
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
