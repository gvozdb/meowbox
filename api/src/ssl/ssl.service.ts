import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { SslStatus } from '../common/enums';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { NotificationDispatcherService } from '../notifications/notification-dispatcher.service';
import { parseStringArray, parseSiteAliases } from '../common/json-array';
import { SiteDomainsService } from '../sites/site-domains.service';
import {
  serializeSslCertificate,
  resolveDomainFilesRelPath,
} from '../sites/site-domains.helper';

/**
 * Timeout'ы certbot'а. Переопределяются env. В норме первый выпуск 1-3 мин,
 * revoke 10-30 сек, но на слабых VPS + больших SAN может затянуться.
 */
const CERTBOT_ISSUE_TIMEOUT_MS = Number(process.env.CERTBOT_ISSUE_TIMEOUT_MS) || 180_000;
const CERTBOT_REVOKE_TIMEOUT_MS = Number(process.env.CERTBOT_REVOKE_TIMEOUT_MS) || 90_000;

/**
 * SSL-операции domain-scoped: каждый основной домен (`SiteDomain`) имеет
 * собственный сертификат (`SslCertificate.domainId`). После любой операции
 * пересобираем nginx всего сайта (через SiteDomainsService.regenerateNginx).
 */
@Injectable()
export class SslService {
  private readonly logger = new Logger('SslService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
    private readonly notifier: NotificationDispatcherService,
    private readonly siteDomains: SiteDomainsService,
  ) {}

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
        site: { select: { id: true, name: true, userId: true, rootPath: true, filesRelPath: true } },
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

  async requestIssuance(siteId: string, domainId: string, userId: string, role: string) {
    const domain = await this.requireDomain(siteId, domainId, userId, role);

    // SAN = домен + ВСЕ его алиасы (включая redirect=true).
    const sanAliases = parseSiteAliases(domain.aliases).map((a) => a.domain);
    const domains = [domain.domain, ...sanAliases];

    const cert = await this.ensureCertRecord(siteId, domainId, domains);
    await this.prisma.sslCertificate.update({
      where: { id: cert.id },
      data: { status: SslStatus.PENDING },
    });

    const filesRelPath = resolveDomainFilesRelPath(
      domain.filesRelPath,
      domain.site.filesRelPath,
    );

    try {
      const raw = await this.agentRelay.emitToAgent<{
        success: boolean;
        certPath?: string;
        keyPath?: string;
        expiresAt?: string;
        domains?: string[];
        error?: string;
      }>(
        'ssl:issue',
        {
          domain: domain.domain,
          domains,
          rootPath: domain.site.rootPath,
          filesRelPath,
        },
        CERTBOT_ISSUE_TIMEOUT_MS,
      );

      const ack = raw as unknown as {
        success?: boolean;
        certPath?: string;
        keyPath?: string;
        expiresAt?: string;
        domains?: string[];
        error?: string;
      };

      if (ack.success) {
        const effectiveDomains =
          ack.domains && ack.domains.length ? ack.domains : domains;
        await this.updateAfterIssuance(
          cert.id,
          siteId,
          true,
          ack.certPath,
          ack.keyPath,
          ack.expiresAt,
          "Let's Encrypt",
          effectiveDomains,
        );
        this.logger.log(`SSL issued for ${domain.domain} (SAN: ${effectiveDomains.join(', ')})`);
        return { siteId, domainId, domain: domain.domain, domains: effectiveDomains };
      } else {
        await this.updateAfterIssuance(cert.id, siteId, false);
        const errorMsg =
          ack.error ||
          raw.error ||
          'Certbot failed (без деталей от агента — проверь pm2 logs meowbox-agent)';
        this.logger.error(`SSL issuance failed for ${domain.domain}: ${errorMsg}`);
        throw new BadRequestException(errorMsg);
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      await this.updateAfterIssuance(cert.id, siteId, false);
      const errorMsg = (err as Error).message;
      this.logger.error(`SSL error for ${domain.domain}: ${errorMsg}`);
      throw new BadRequestException(errorMsg);
    }
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
    await this.siteDomains.regenerateNginx(siteId).catch((err) => {
      this.logger.warn(`SSL reconfigure for site ${siteId} failed: ${(err as Error).message}`);
    });
  }

  // ===========================================================================
  // Revoke
  // ===========================================================================

  async revokeCertificate(siteId: string, domainId: string, userId: string, role: string) {
    const domain = await this.requireDomain(siteId, domainId, userId, role);
    const cert = domain.sslCertificate;
    if (!cert || cert.status === SslStatus.NONE) {
      throw new BadRequestException('SSL certificate is not issued for this domain');
    }
    if (!this.agentRelay.isAgentConnected()) {
      throw new BadRequestException('Agent is offline — cannot revoke certificate');
    }

    const raw = await this.agentRelay.emitToAgent<{ success?: boolean; error?: string }>(
      'ssl:revoke',
      { domain: domain.domain },
      CERTBOT_REVOKE_TIMEOUT_MS,
    );
    const ack = raw as unknown as { success?: boolean; error?: string };
    const revokeOk = !!ack.success;
    if (!revokeOk) {
      this.logger.warn(
        `ssl:revoke failed for ${domain.domain}: ${ack.error || raw.error || 'unknown'}`,
      );
    }

    await this.prisma.sslCertificate.update({
      where: { id: cert.id },
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

    await this.siteDomains.regenerateNginx(siteId).catch((err) => {
      this.logger.warn(`Post-revoke reconfigure failed: ${(err as Error).message}`);
    });

    this.logger.log(`SSL revoked for ${domain.domain}`);
    return {
      revoked: revokeOk,
      warning: revokeOk ? null : 'Certbot revoke не завершился чисто, но запись удалена',
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
        status: { in: [SslStatus.ACTIVE, SslStatus.EXPIRING_SOON] },
        expiresAt: { not: null },
      },
      include: { domain: { select: { domain: true } } },
    });

    for (const cert of certs) {
      if (!cert.expiresAt) continue;
      const daysRemaining = Math.floor(
        (cert.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
      );

      let newStatus = cert.status;
      if (daysRemaining <= 0) {
        newStatus = SslStatus.EXPIRED;
      } else if (daysRemaining <= 30) {
        newStatus = SslStatus.EXPIRING_SOON;
      } else {
        newStatus = SslStatus.ACTIVE;
      }

      if (newStatus !== cert.status || cert.daysRemaining !== daysRemaining) {
        await this.prisma.sslCertificate.update({
          where: { id: cert.id },
          data: { status: newStatus, daysRemaining },
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
