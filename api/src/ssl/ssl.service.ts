import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as path from 'node:path';
import { DOMAIN_REGEX } from '@meowbox/shared';
import { SslStatus } from '../common/enums';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { NotificationDispatcherService } from '../notifications/notification-dispatcher.service';
import { parseStringArray, parseSiteAliases } from '../common/json-array';
import { SiteDomainsService } from '../sites/site-domains.service';
import { serializeSslCertificate } from '../sites/site-domains.helper';
import { OperationAdmissionService } from '../operations/operation-admission.service';
import {
  OperationsWorkerService,
  type OperationExecutionContext,
} from '../operations/operations-worker.service';
import { OperationNeedsAttentionError } from '../operations/operation-errors';

/**
 * Inspection остаётся bounded read. Выпуск и отзыв выполняются через durable
 * AgentJob, поэтому их время не связано с HTTP relay timeout.
 */
const CERTBOT_INSPECT_TIMEOUT_MS = 300_000;
const SSL_OPERATION_ACTIONS = {
  ISSUE: 'ssl.issue',
  REVOKE: 'ssl.revoke',
} as const;
const SSL_AGENT_ACTIONS = {
  [SSL_OPERATION_ACTIONS.ISSUE]: 'agent.ssl.issue',
  [SSL_OPERATION_ACTIONS.REVOKE]: 'agent.ssl.revoke',
} as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SslIssueOperationRequest {
  siteId: string;
  domainId: string;
}

interface SslIssueAgentResult {
  certPath: string;
  keyPath: string;
  expiresAt: string;
  domains: string[];
}

function validateSslOperationRequest(request: unknown): SslIssueOperationRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new BadRequestException('SSL operation request is invalid');
  }
  const value = request as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !== 'domainId,siteId' ||
    typeof value.siteId !== 'string' ||
    typeof value.domainId !== 'string' ||
    !UUID.test(value.siteId) ||
    !UUID.test(value.domainId)
  ) {
    throw new BadRequestException('SSL operation request is invalid');
  }
  return value as unknown as SslIssueOperationRequest;
}

function normalizeSanDomains(domain: string, aliases: string[]): string[] {
  const normalized = Array.from(
    new Set([domain, ...aliases].map((value) => value.trim().toLowerCase())),
  );
  if (
    normalized.length < 1 ||
    normalized.length > 65 ||
    normalized.some((value) => value.length > 253 || !DOMAIN_REGEX.test(value))
  ) {
    throw new BadRequestException('SSL certificate domain set is invalid');
  }
  return normalized;
}

function isExpectedCertificatePath(value: string, domain: string, basename: string): boolean {
  return (
    value.length <= 4096 &&
    path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    path.posix.basename(value) === basename &&
    path.posix.basename(path.posix.dirname(value)) === domain
  );
}

function validateIssueAgentResult(
  result: unknown,
  requestedDomains: string[],
): SslIssueAgentResult {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new OperationNeedsAttentionError('SSL issuance returned an invalid result');
  }
  const value = result as Record<string, unknown>;
  const allowedKeys = new Set(['certPath', 'keyPath', 'expiresAt', 'domains']);
  const primaryDomain = requestedDomains[0];
  if (
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    typeof value.certPath !== 'string' ||
    typeof value.keyPath !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    !Array.isArray(value.domains) ||
    value.domains.length < 1 ||
    value.domains.length > 65 ||
    value.domains.some((domain) => typeof domain !== 'string') ||
    !isExpectedCertificatePath(value.certPath, primaryDomain, 'fullchain.pem') ||
    !isExpectedCertificatePath(value.keyPath, primaryDomain, 'privkey.pem') ||
    path.posix.dirname(value.certPath) !== path.posix.dirname(value.keyPath)
  ) {
    throw new OperationNeedsAttentionError('SSL issuance returned invalid certificate metadata');
  }
  const expiresAt = new Date(value.expiresAt);
  const actualDomains = Array.from(
    new Set((value.domains as string[]).map((domain) => domain.trim().toLowerCase())),
  );
  const actualSet = new Set(actualDomains);
  if (
    Number.isNaN(expiresAt.getTime()) ||
    expiresAt.getTime() <= Date.now() ||
    actualDomains.some((domain) => domain.length > 253 || !DOMAIN_REGEX.test(domain)) ||
    requestedDomains.some((domain) => !actualSet.has(domain))
  ) {
    throw new OperationNeedsAttentionError('Issued certificate metadata does not match request');
  }
  return {
    certPath: value.certPath,
    keyPath: value.keyPath,
    expiresAt: expiresAt.toISOString(),
    domains: actualDomains,
  };
}

function validateRevokeAgentResult(result: unknown): { removed: true; revoked: boolean } {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new OperationNeedsAttentionError('SSL revoke returned an invalid result');
  }
  const value = result as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !== 'removed,revoked' ||
    value.removed !== true ||
    typeof value.revoked !== 'boolean'
  ) {
    throw new OperationNeedsAttentionError('SSL revoke did not confirm artifact removal');
  }
  return { removed: true, revoked: value.revoked };
}

interface ExistingSslInspection {
  domain: string;
  success: boolean;
  found: boolean;
  certPath?: string;
  keyPath?: string;
  expiresAt?: string;
  domains?: string[];
  error?: string;
}

/**
 * SSL-операции domain-scoped: каждый основной домен (`SiteDomain`) имеет
 * собственный сертификат (`SslCertificate.domainId`). После любой операции
 * пересобираем nginx всего сайта (через SiteDomainsService.regenerateNginx).
 */
@Injectable()
export class SslService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('SslService');
  private unregisterOperationHandlers: Array<() => void> = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
    private readonly notifier: NotificationDispatcherService,
    private readonly siteDomains: SiteDomainsService,
    private readonly admission: OperationAdmissionService,
    private readonly worker: OperationsWorkerService,
  ) {}

  onModuleInit(): void {
    this.unregisterOperationHandlers.push(
      this.worker.registerHandler(
        SSL_OPERATION_ACTIONS.ISSUE,
        (request, context) => this.executeIssuance(request, context),
      ),
      this.worker.registerHandler(
        SSL_OPERATION_ACTIONS.REVOKE,
        (request, context) => this.executeRevoke(request, context),
      ),
    );
  }

  onModuleDestroy(): void {
    for (const unregister of this.unregisterOperationHandlers.splice(0)) unregister();
  }

  // ===========================================================================
  // Overview (все сертификаты)
  // ===========================================================================

  async findAll(userId: string, role: string) {
    const where =
      role === 'ADMIN'
        ? { status: { not: 'NONE' as const } }
        : { status: { not: 'NONE' as const }, site: { userId } };

    const certs = await this.prisma.sslCertificate.findMany({
      where,
      orderBy: { expiresAt: 'asc' },
      select: {
        siteId: true,
        domainId: true,
        domains: true,
        status: true,
        issuer: true,
        isWildcard: true,
        issuedAt: true,
        expiresAt: true,
        daysRemaining: true,
        site: { select: { id: true, name: true } },
        domain: { select: { id: true, domain: true, aliases: true } },
      },
    });

    return certs.map((c) => {
      const domainsInCert = parseStringArray(c.domains);
      const domainsSet = new Set(domainsInCert.map((d) => d.toLowerCase()));
      const aliases = parseSiteAliases(c.domain?.aliases);
      // Включаем И redirect-алиасы: им тоже нужен SAN — TLS-handshake идёт
      // ДО ответа nginx, без серта браузер показывает cert error.
      const missingAliases = aliases
        .filter((a) => !domainsSet.has(a.domain.toLowerCase()))
        .map((a) => a.domain);
      const mainDomain = c.domain?.domain || '';
      const missingMainDomain = !domainsSet.has(mainDomain.toLowerCase());

      return {
        siteId: c.siteId,
        siteName: c.site.name,
        domainId: c.domainId,
        domain: mainDomain,
        domains: domainsInCert,
        missingAliases,
        missingMainDomain,
        status: c.status,
        issuer: c.issuer,
        isWildcard: c.isWildcard,
        issuedAt: c.issuedAt?.toISOString() || null,
        expiresAt: c.expiresAt?.toISOString() || null,
        daysRemaining: c.daysRemaining,
      };
    });
  }

  // ===========================================================================
  // Domain-scoped helpers
  // ===========================================================================

  /**
   * Загружает основной домен (с сайтом и сертификатом), проверяет доступ и
   * принадлежность сайту. Создаёт SSL-placeholder если его ещё нет.
   */
  private async requireDomain(siteId: string, domainId: string, userId: string, role: string) {
    const domain = await this.prisma.siteDomain.findUnique({
      where: { id: domainId },
      include: {
        site: { select: { id: true, name: true, userId: true, rootPath: true } },
        sslCertificate: true,
      },
    });
    if (!domain || domain.siteId !== siteId) {
      throw new NotFoundException('Domain not found');
    }
    if (role !== 'ADMIN' && domain.site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    return domain;
  }

  /** Возвращает существующий SslCertificate домена или создаёт placeholder. */
  private async ensureCertRecord(siteId: string, domainId: string, sanDomains: string[]) {
    const existing = await this.prisma.sslCertificate.findUnique({ where: { domainId } });
    if (existing) return existing;
    return this.prisma.sslCertificate.create({
      data: {
        siteId,
        domainId,
        domains: JSON.stringify(sanDomains),
        status: SslStatus.NONE,
        issuer: '',
      },
    });
  }

  async findByDomain(siteId: string, domainId: string, userId: string, role: string) {
    const domain = await this.requireDomain(siteId, domainId, userId, role);
    const cert =
      domain.sslCertificate ??
      (await this.ensureCertRecord(siteId, domainId, [domain.domain]));
    return serializeSslCertificate(cert);
  }

  // ===========================================================================
  // Выпуск Let's Encrypt
  // ===========================================================================

  async enqueueIssuance(
    siteId: string,
    domainId: string,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    await this.requireDomain(siteId, domainId, actor.userId, actor.role);
    return this.admission.admit({
      actionId: SSL_OPERATION_ACTIONS.ISSUE,
      type: 'SSL_ISSUE',
      idempotencyKey,
      actor,
      request: { siteId, domainId },
      deadlineMs: 10 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      siteId,
      siteDomainId: domainId,
      lockSite: true,
    });
  }

  private async executeIssuance(
    request: unknown,
    context: OperationExecutionContext,
  ): Promise<unknown> {
    const { siteId, domainId } = validateSslOperationRequest(request);
    const domain = await this.prisma.siteDomain.findUnique({
      where: { id: domainId },
      include: {
        site: { select: { id: true } },
        sslCertificate: true,
      },
    });
    if (!domain || domain.siteId !== siteId || domain.site.id !== siteId) {
      throw new OperationNeedsAttentionError('SSL target domain no longer exists');
    }
    const domains = normalizeSanDomains(
      domain.domain,
      parseSiteAliases(domain.aliases).map((alias) => alias.domain),
    );
    const cert = domain.sslCertificate ?? await this.ensureCertRecord(siteId, domainId, domains);

    await context.throwIfCancellationRequested();
    await context.heartbeat('certbot', 10);
    const rawResult = await this.agentRelay.runAgentJob(
      {
        operationId: context.operationId,
        actionId: SSL_AGENT_ACTIONS[SSL_OPERATION_ACTIONS.ISSUE],
        step: 'certbot',
        payload: { domain: domains[0], domains },
        deadlineAt: context.deadlineAt,
        cancelSafe: false,
      },
      () => context.isCancellationRequested(),
    );
    const result = validateIssueAgentResult(rawResult, domains);

    await context.heartbeat('persist', 85);
    await this.updateAfterIssuance(
      cert.id,
      siteId,
      true,
      result.certPath,
      result.keyPath,
      result.expiresAt,
      "Let's Encrypt",
      result.domains,
      true,
    );
    this.logger.log(`SSL issued for ${domains[0]} (SAN: ${result.domains.join(', ')})`);
    return {
      siteId,
      domainId,
      domain: domains[0],
      domains: result.domains,
      expiresAt: result.expiresAt,
    };
  }

  /** Пишет результат выпуска в БД + регенерирует nginx всего сайта. */
  private async updateAfterIssuance(
    certId: string,
    siteId: string,
    success: boolean,
    certPath?: string,
    keyPath?: string,
    expiresAt?: string,
    issuer?: string,
    domains?: string[],
    strictReconfigure = false,
  ) {
    if (!success) {
      await this.prisma.sslCertificate.update({
        where: { id: certId },
        data: { status: SslStatus.NONE },
      });
      return;
    }

    const expiresDate = expiresAt ? new Date(expiresAt) : null;
    const daysRemaining = expiresDate
      ? Math.floor((expiresDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
      : null;

    const updateData: Record<string, unknown> = {
      status: SslStatus.ACTIVE,
      certPath,
      keyPath,
      issuedAt: new Date(),
      expiresAt: expiresDate,
      daysRemaining,
      issuer: issuer || "Let's Encrypt",
    };
    if (Array.isArray(domains) && domains.length) {
      updateData.domains = JSON.stringify(
        Array.from(new Set(domains.map((d) => d.trim().toLowerCase()))).filter(Boolean),
      );
    }

    await this.prisma.sslCertificate.update({
      where: { id: certId },
      data: updateData,
    });

    // Пересобираем nginx всего сайта (server-блок домена получает TLS +
    // HTTP→HTTPS редирект).
    if (strictReconfigure) {
      await this.siteDomains.regenerateNginx(siteId);
    } else {
      await this.siteDomains.regenerateNginx(siteId).catch((err) => {
        this.logger.warn(`SSL reconfigure for site ${siteId} failed: ${(err as Error).message}`);
      });
    }
  }

  // ===========================================================================
  // Revoke
  // ===========================================================================

  async enqueueRevoke(
    siteId: string,
    domainId: string,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    const domain = await this.requireDomain(siteId, domainId, actor.userId, actor.role);
    const cert = domain.sslCertificate;
    if (!cert || cert.status === SslStatus.NONE) {
      throw new BadRequestException('SSL certificate is not issued for this domain');
    }
    return this.admission.admit({
      actionId: SSL_OPERATION_ACTIONS.REVOKE,
      type: 'SSL_REVOKE',
      idempotencyKey,
      actor,
      request: { siteId, domainId },
      deadlineMs: 10 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      siteId,
      siteDomainId: domainId,
      lockSite: true,
    });
  }

  private async executeRevoke(
    request: unknown,
    context: OperationExecutionContext,
  ): Promise<unknown> {
    const { siteId, domainId } = validateSslOperationRequest(request);
    const domain = await this.prisma.siteDomain.findUnique({
      where: { id: domainId },
      include: { sslCertificate: true },
    });
    if (!domain || domain.siteId !== siteId) {
      throw new OperationNeedsAttentionError('SSL target domain no longer exists');
    }
    const normalizedDomain = normalizeSanDomains(domain.domain, [])[0];

    if (!domain.sslCertificate || domain.sslCertificate.status === SslStatus.NONE) {
      if (!context.recovering) {
        throw new OperationNeedsAttentionError('SSL certificate state changed before revoke');
      }
      await context.heartbeat('nginx', 90);
      await this.siteDomains.regenerateNginx(siteId);
      return { siteId, domainId, domain: normalizedDomain, removed: true, reconciled: true };
    }

    await context.throwIfCancellationRequested();
    await context.heartbeat('certbot-revoke', 10);
    const rawResult = await this.agentRelay.runAgentJob(
      {
        operationId: context.operationId,
        actionId: SSL_AGENT_ACTIONS[SSL_OPERATION_ACTIONS.REVOKE],
        step: 'certbot-revoke',
        payload: { domain: normalizedDomain },
        deadlineAt: context.deadlineAt,
        cancelSafe: false,
      },
      () => context.isCancellationRequested(),
    );
    const result = validateRevokeAgentResult(rawResult);

    await context.heartbeat('persist', 80);
    await this.prisma.sslCertificate.update({
      where: { id: domain.sslCertificate.id },
      data: {
        status: SslStatus.NONE,
        certPath: null,
        keyPath: null,
        issuedAt: null,
        expiresAt: null,
        daysRemaining: null,
        issuer: '',
      },
    });
    await context.heartbeat('nginx', 90);
    await this.siteDomains.regenerateNginx(siteId);

    this.logger.log(`SSL artifacts removed for ${normalizedDomain}`);
    return {
      siteId,
      domainId,
      domain: normalizedDomain,
      removed: result.removed,
      revoked: result.revoked,
      warning: result.revoked ? null : 'Certificate removed locally; ACME revoke was not confirmed',
    };
  }

  // ===========================================================================
  // Import (подхватить уже выпущенный на диске)
  // ===========================================================================

  async importExistingCertificate(siteId: string, domainId: string, userId: string, role: string) {
    const domain = await this.requireDomain(siteId, domainId, userId, role);
    if (!this.agentRelay.isAgentConnected()) {
      throw new BadRequestException('Agent is offline');
    }
    const cert = await this.ensureCertRecord(siteId, domainId, [domain.domain]);

    const result = await this.agentRelay.emitToAgent<{
      found: boolean;
      certPath?: string;
      keyPath?: string;
      expiresAt?: string;
      domains?: string[];
    }>('ssl:inspect-existing', { domain: domain.domain }, 30_000);

    if (!result.success || !result.data?.found) {
      throw new BadRequestException(
        result.error || (result.data && !result.data.found)
          ? `На диске нет действующего сертификата для ${domain.domain}`
          : 'Не удалось проверить сертификат на диске',
      );
    }

    await this.updateAfterIssuance(
      cert.id,
      siteId,
      true,
      result.data.certPath,
      result.data.keyPath,
      result.data.expiresAt,
      "Let's Encrypt",
      result.data.domains,
    );

    this.logger.log(`SSL imported from disk for ${domain.domain}`);
    return {
      imported: true,
      certPath: result.data.certPath,
      expiresAt: result.data.expiresAt,
    };
  }

  // ===========================================================================
  // Custom certificate
  // ===========================================================================

  async installCustomCertificate(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    certPem: string,
    keyPem: string,
    chainPem?: string,
  ) {
    const domain = await this.requireDomain(siteId, domainId, userId, role);
    const cert = await this.ensureCertRecord(siteId, domainId, [domain.domain]);

    await this.prisma.sslCertificate.update({
      where: { id: cert.id },
      data: { status: SslStatus.PENDING },
    });

    try {
      const raw = await this.agentRelay.emitToAgent<{
        success?: boolean;
        certPath?: string;
        keyPath?: string;
        expiresAt?: string;
        domains?: string[];
        error?: string;
      }>('ssl:install-custom', {
        domain: domain.domain,
        certPem,
        keyPem,
        chainPem,
      });

      const ack = raw as unknown as {
        success?: boolean;
        certPath?: string;
        keyPath?: string;
        expiresAt?: string;
        domains?: string[];
        error?: string;
      };

      if (ack.success) {
        await this.updateAfterIssuance(
          cert.id,
          siteId,
          true,
          ack.certPath,
          ack.keyPath,
          ack.expiresAt,
          'Custom',
          ack.domains,
        );
        this.logger.log(`Custom SSL installed for ${domain.domain}`);
        return { success: true };
      } else {
        await this.updateAfterIssuance(cert.id, siteId, false);
        throw new BadRequestException(ack.error || raw.error || 'Custom SSL installation failed');
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      await this.updateAfterIssuance(cert.id, siteId, false);
      throw new BadRequestException((err as Error).message);
    }
  }

  // ===========================================================================
  // Expiration cron
  // ===========================================================================

  async checkExpirations() {
    const certs = await this.prisma.sslCertificate.findMany({
      where: {
        status: { in: [SslStatus.ACTIVE, SslStatus.EXPIRING_SOON, SslStatus.EXPIRED] },
      },
      include: { domain: { select: { domain: true } } },
    });

    const letsEncryptDomains = certs
      .filter((cert) => cert.certPath?.startsWith('/etc/letsencrypt/live/'))
      .map((cert) => cert.domain?.domain)
      .filter((domain): domain is string => !!domain);
    const inspections = new Map<string, ExistingSslInspection>();

    if (letsEncryptDomains.length > 0 && this.agentRelay.isAgentConnected()) {
      try {
        const result = await this.agentRelay.emitToAgent<{
          certificates: ExistingSslInspection[];
        }>(
          'ssl:inspect-existing-many',
          { domains: letsEncryptDomains },
          CERTBOT_INSPECT_TIMEOUT_MS,
        );
        if (!result.success) {
          this.logger.warn(`SSL metadata sync failed: ${result.error || 'unknown agent error'}`);
        } else {
          const certificates = Array.isArray(result.data?.certificates)
            ? result.data.certificates
            : [];
          for (const inspection of certificates) {
            if (typeof inspection?.domain === 'string') {
              inspections.set(inspection.domain.toLowerCase(), inspection);
            }
          }
        }
      } catch (err) {
        this.logger.warn(`SSL metadata sync skipped: ${(err as Error).message}`);
      }
    }

    for (const cert of certs) {
      const domain = cert.domain?.domain.toLowerCase();
      const inspection = domain ? inspections.get(domain) : undefined;
      let expiresAt = cert.expiresAt;
      const metadataUpdate: Record<string, unknown> = {};

      if (inspection?.success && inspection.found && inspection.expiresAt) {
        const inspectedExpiry = new Date(inspection.expiresAt);
        if (!Number.isNaN(inspectedExpiry.getTime())) {
          expiresAt = inspectedExpiry;
          if (!cert.expiresAt || cert.expiresAt.getTime() !== inspectedExpiry.getTime()) {
            metadataUpdate.expiresAt = inspectedExpiry;
          }
          if (inspection.certPath && inspection.certPath !== cert.certPath) {
            metadataUpdate.certPath = inspection.certPath;
          }
          if (inspection.keyPath && inspection.keyPath !== cert.keyPath) {
            metadataUpdate.keyPath = inspection.keyPath;
          }
          if (inspection.domains?.length) {
            const inspectedDomains = JSON.stringify(
              Array.from(new Set(inspection.domains.map((item) => item.trim().toLowerCase())))
                .filter(Boolean),
            );
            if (inspectedDomains !== cert.domains) metadataUpdate.domains = inspectedDomains;
          }
        }
      }

      if (!expiresAt) continue;
      const daysRemaining = Math.floor(
        (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
      );

      let newStatus = cert.status;
      if (daysRemaining <= 0) {
        newStatus = SslStatus.EXPIRED;
      } else if (daysRemaining <= 30) {
        newStatus = SslStatus.EXPIRING_SOON;
      } else {
        newStatus = SslStatus.ACTIVE;
      }

      if (
        newStatus !== cert.status ||
        cert.daysRemaining !== daysRemaining ||
        Object.keys(metadataUpdate).length > 0
      ) {
        await this.prisma.sslCertificate.update({
          where: { id: cert.id },
          data: { ...metadataUpdate, status: newStatus, daysRemaining },
        });

        const statusChanged =
          newStatus !== cert.status &&
          (newStatus === SslStatus.EXPIRING_SOON || newStatus === SslStatus.EXPIRED);
        const isMilestone = [7, 3, 1, 0].includes(daysRemaining);
        if (statusChanged || isMilestone) {
          const site = await this.prisma.site.findUnique({
            where: { id: cert.siteId },
            select: { name: true },
          });
          const certDomain = cert.domain?.domain || 'unknown';
          this.notifier
            .dispatch({
              event: 'SSL_EXPIRING',
              title:
                daysRemaining <= 0
                  ? 'SSL Certificate Expired'
                  : `SSL Certificate Expires in ${daysRemaining} Day${daysRemaining === 1 ? '' : 's'}`,
              message:
                daysRemaining <= 0
                  ? `SSL certificate for ${certDomain} has expired`
                  : `SSL certificate for ${certDomain} expires in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`,
              siteName: site?.name,
              timestamp: new Date(),
            })
            .catch((err) => this.logger.error(`Notification failed: ${(err as Error).message}`));
        }
      }
    }
  }
}
