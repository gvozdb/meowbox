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
import { siteNginxOverrides } from '@meowbox/shared';

/**
 * Timeout'ы certbot'а. Переопределяются env. В норме первый выпуск 1-3 мин,
 * revoke 10-30 сек, но на слабых VPS + больших SAN может затянуться.
 */
const CERTBOT_ISSUE_TIMEOUT_MS = Number(process.env.CERTBOT_ISSUE_TIMEOUT_MS) || 180_000;
const CERTBOT_REVOKE_TIMEOUT_MS = Number(process.env.CERTBOT_REVOKE_TIMEOUT_MS) || 90_000;

@Injectable()
export class SslService {
  private readonly logger = new Logger('SslService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
    private readonly notifier: NotificationDispatcherService,
  ) {}

  async findAll(userId: string, role: string) {
    const where = role === 'ADMIN'
      ? { status: { not: 'NONE' as const } }
      : { status: { not: 'NONE' as const }, site: { userId } };

    const certs = await this.prisma.sslCertificate.findMany({
      where,
      orderBy: { expiresAt: 'asc' },
      select: {
        siteId: true,
        domains: true,
        status: true,
        issuer: true,
        isWildcard: true,
        issuedAt: true,
        expiresAt: true,
        daysRemaining: true,
        // aliases нужны, чтобы вычислить missingAliases — алиасы, не покрытые
        // SAN текущего серта. Включая redirect-алиасы: TLS-handshake идёт
        // ДО ответа nginx, и без серта на www-домене браузер показывает
        // cert error раньше, чем мы успеваем отдать 301. Поэтому редирект-
        // алиасам тоже нужен валидный SAN.
        site: { select: { id: true, name: true, domain: true, aliases: true } },
      },
    });

    return certs.map((c) => {
      const domainsInCert = parseStringArray(c.domains);
      const domainsSet = new Set(domainsInCert.map((d) => d.toLowerCase()));
      const aliases = parseSiteAliases(c.site.aliases);
      // Включаем И redirect-алиасы: им тоже нужен SAN, иначе браузер
      // показывает cert mismatch до того как nginx отдаст 301 редирект.
      const missingAliases = aliases
        .filter((a) => !domainsSet.has(a.domain.toLowerCase()))
        .map((a) => a.domain);
      // Основной домен должен быть в серте — если почему-то нет, это тоже
      // сигнал о проблеме. Кладём в отдельное поле.
      const missingMainDomain = !domainsSet.has((c.site.domain || '').toLowerCase());

      return {
        siteId: c.siteId,
        siteName: c.site.name,
        domain: c.site.domain,
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

  async findBySite(siteId: string, userId: string, role: string) {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { userId: true },
    });

    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    const cert = await this.prisma.sslCertificate.findUnique({
      where: { siteId },
    });

    if (!cert) throw new NotFoundException('SSL certificate record not found');
    return { ...cert, domains: parseStringArray(cert.domains) };
  }

  async requestIssuance(siteId: string, userId: string, role: string) {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      include: { sslCertificate: true },
    });

    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    if (!site.sslCertificate) {
      throw new BadRequestException('SSL certificate record not initialized');
    }

    // Mark as pending
    await this.prisma.sslCertificate.update({
      where: { siteId },
      data: { status: SslStatus.PENDING },
    });

    // В SAN кладём ВСЕ алиасы — и non-redirect, и redirect. TLS-handshake
    // выполняется ДО того, как nginx может отдать 301 редирект, поэтому
    // даже редирект-алиасу нужен валидный серт. Иначе браузер на
    // https://www.example.com показывает «незащищённое соединение» и юзер
    // должен вручную нажать «продолжить», чтобы наш 301→main сработал.
    // Покрытие всех алиасов — must, не «nice to have».
    const sanAliases = parseSiteAliases(site.aliases).map((a) => a.domain);
    const domains = [site.domain, ...sanAliases];

    // =========================================================================
    // Agent: issue SSL certificate via certbot.
    //
    // ВАЖНО: агент `ssl:issue` отдаёт в callback РАЗВЁРНУТЫЙ SslResult
    // прямо на верхнем уровне (`{success, certPath, keyPath, expiresAt, error}`),
    // а не обёрнутый в `{data: ...}`. Раньше мы читали `result.data.*` — и на
    // успехе получали `result.data = undefined` → падали в else-ветку с
    // генерическим "Certbot failed", даже когда certbot реально выпустил серт.
    // Теперь читаем плоско, падаем и на `result.error`, и на socket-level
    // `raw.error` (если он прилетит).
    // =========================================================================
    try {
      const raw = await this.agentRelay.emitToAgent<{
        success: boolean;
        certPath?: string;
        keyPath?: string;
        expiresAt?: string;
        domains?: string[];
        error?: string;
      }>('ssl:issue', {
        domain: site.domain,
        domains,
        rootPath: site.rootPath,
        // ОБЯЗАТЕЛЬНО передаём filesRelPath: certbot должен класть
        // challenge в ту же директорию, откуда nginx её отдаёт. Если
        // юзер сменил web-root (например, на `www/public` для Laravel/MODX),
        // без этого certbot пишет в `www/.well-known/...`, а nginx
        // отдаёт 404 из `www/public/.well-known/...`.
        filesRelPath: site.filesRelPath,
      }, CERTBOT_ISSUE_TIMEOUT_MS);

      // Socket.io ack прилетает как есть — нормализуем к плоскому виду.
      const ack = (raw as unknown) as {
        success?: boolean;
        certPath?: string;
        keyPath?: string;
        expiresAt?: string;
        domains?: string[];
        error?: string;
      };

      if (ack.success) {
        // Агент вернул реальный SAN, распарсенный из серта на диске —
        // это truthful источник. Если по какой-то причине он пустой
        // (openssl упал/нет), берём то, что передавали certbot'у —
        // certbot'у --expand передаются ровно эти домены.
        const effectiveDomains =
          ack.domains && ack.domains.length ? ack.domains : domains;
        await this.updateAfterIssuance(
          siteId,
          true,
          ack.certPath,
          ack.keyPath,
          ack.expiresAt,
          "Let's Encrypt",
          effectiveDomains,
        );
        this.logger.log(`SSL issued for ${site.domain} (SAN: ${effectiveDomains.join(', ')})`);
        return { siteId, domain: site.domain, domains: effectiveDomains };
      } else {
        await this.updateAfterIssuance(siteId, false);
        const errorMsg =
          ack.error ||
          raw.error ||
          'Certbot failed (без деталей от агента — проверь pm2 logs meowbox-agent)';
        this.logger.error(`SSL issuance failed for ${site.domain}: ${errorMsg}`);
        throw new BadRequestException(errorMsg);
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      await this.updateAfterIssuance(siteId, false);
      const errorMsg = (err as Error).message;
      this.logger.error(`SSL error for ${site.domain}: ${errorMsg}`);
      throw new BadRequestException(errorMsg);
    }
  }

  async updateAfterIssuance(
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
        where: { siteId },
        data: { status: SslStatus.NONE },
      });
      return;
    }

    const expiresDate = expiresAt ? new Date(expiresAt) : null;
    const daysRemaining = expiresDate
      ? Math.floor((expiresDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
      : null;

    const updateData: {
      status: string;
      certPath?: string;
      keyPath?: string;
      issuedAt: Date;
      expiresAt: Date | null;
      daysRemaining: number | null;
      issuer: string;
      domains?: string;
    } = {
      status: SslStatus.ACTIVE,
      certPath,
      keyPath,
      issuedAt: new Date(),
      expiresAt: expiresDate,
      daysRemaining,
      issuer: issuer || "Let's Encrypt",
    };
    // Перезаписываем поле `domains` только если передали непустой список —
    // не хотим затирать существующий SAN из-за бага парсинга.
    if (Array.isArray(domains) && domains.length) {
      updateData.domains = JSON.stringify(
        Array.from(new Set(domains.map((d) => d.trim().toLowerCase()))).filter(Boolean),
      );
    }

    await this.prisma.sslCertificate.update({
      where: { siteId },
      data: updateData,
    });

    // После выпуска сертификата надо:
    //   1. Переписать nginx-конфиг, чтобы server-блок получил TLS и HTTP→HTTPS
    //      редирект (httpsRedirect=true по умолчанию).
    //   2. Пересоздать PHP-FPM pool с cookie_secure=On — иначе сессии не
    //      будут переживать редиректы и логин в админки зациклится.
    await this.reconfigureSiteAfterSslChange(siteId).catch((err) => {
      this.logger.warn(
        `SSL reconfigure for ${siteId} failed: ${(err as Error).message}`,
      );
    });
  }

  /**
   * Пересобирает nginx-конфиг и PHP-FPM-пул сайта после изменения SSL-статуса
   * (выпуск Let's Encrypt / установка кастомного серта / вывод сертификата).
   * Дёргается из updateAfterIssuance — если сертификат ACTIVE, передаёт
   * sslEnabled=true; в противном случае sslEnabled=false.
   */
  private async reconfigureSiteAfterSslChange(siteId: string): Promise<void> {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      include: { sslCertificate: true },
    });
    if (!site) return;

    const ssl = site.sslCertificate;
    const sslActive =
      !!(ssl && ssl.status === SslStatus.ACTIVE && ssl.certPath && ssl.keyPath);

    const aliases = parseSiteAliases(site.aliases);

    if (this.agentRelay.isAgentConnected()) {
      // Nginx — всегда переписываем, даже если статус тот же: это кейс
      // обновления сертификата (renewal может не менять статус, но путь остаётся).
      try {
        // siteNginxOverrides + initial custom — собираем payload из site.
        const siteSettings = siteNginxOverrides(site as Parameters<typeof siteNginxOverrides>[0]);
        await this.agentRelay.emitToAgent('nginx:create-config', {
          siteName: site.name,
          siteType: site.type,
          domain: site.domain,
          aliases,
          rootPath: site.rootPath,
          filesRelPath: site.filesRelPath,
          phpVersion: site.phpVersion,
          phpEnabled: !!site.phpVersion,
          appPort: site.appPort,
          systemUser: site.systemUser,
          sslEnabled: sslActive,
          certPath: sslActive ? ssl!.certPath : undefined,
          keyPath: sslActive ? ssl!.keyPath : undefined,
          httpsRedirect: site.httpsRedirect,
          settings: siteSettings,
          customConfig: (site as { nginxCustomConfig?: string | null }).nginxCustomConfig ?? undefined,
        });
      } catch (err) {
        this.logger.warn(`nginx reload after SSL: ${(err as Error).message}`);
      }

      // PHP-FPM — перезаписываем только если PHP-пул есть.
      if (site.phpVersion) {
        try {
          await this.agentRelay.emitToAgent('php:create-pool', {
            siteName: site.name,
            domain: site.domain,
            phpVersion: site.phpVersion,
            user: site.systemUser,
            rootPath: site.rootPath,
            sslEnabled: sslActive,
            customConfig: (site as { phpPoolCustom?: string | null }).phpPoolCustom ?? null,
          });
        } catch (err) {
          this.logger.warn(`php pool reload after SSL: ${(err as Error).message}`);
        }
      }
    }
  }

  /**
   * Отозвать (и удалить) Let's Encrypt сертификат через UI.
   * Вызывает на агенте `ssl:revoke` (certbot revoke --delete-after-revoke),
   * сбрасывает статус в NONE и пересобирает nginx/php без SSL.
   */
  async revokeCertificate(siteId: string, userId: string, role: string) {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      include: { sslCertificate: true },
    });
    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    if (!site.sslCertificate || site.sslCertificate.status === SslStatus.NONE) {
      throw new BadRequestException('SSL certificate is not issued for this site');
    }

    if (!this.agentRelay.isAgentConnected()) {
      throw new BadRequestException('Agent is offline — cannot revoke certificate');
    }

    const raw = await this.agentRelay.emitToAgent<{ success?: boolean; error?: string }>(
      'ssl:revoke',
      { domain: site.domain },
      CERTBOT_REVOKE_TIMEOUT_MS,
    );
    const ack = raw as unknown as { success?: boolean; error?: string };

    // Если revoke провалился (например, серт уже удалён с диска) — продолжаем
    // чистить БД, но логируем warn. Пусть UI не зависает от сетевой проблемы.
    const revokeOk = !!ack.success;
    if (!revokeOk) {
      this.logger.warn(`ssl:revoke failed for ${site.domain}: ${ack.error || raw.error || 'unknown'}`);
    }

    await this.prisma.sslCertificate.update({
      where: { siteId },
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

    // Пересобрать nginx + php-fpm уже без SSL.
    await this.reconfigureSiteAfterSslChange(siteId).catch((err) => {
      this.logger.warn(`Post-revoke reconfigure failed: ${(err as Error).message}`);
    });

    this.logger.log(`SSL revoked for ${site.domain}`);
    return {
      revoked: revokeOk,
      warning: revokeOk ? null : 'Certbot revoke не завершился чисто, но запись удалена',
    };
  }

  /**
   * Подхватить УЖЕ выпущенный на диске сертификат (не выпуская заново).
   * Используется когда админ сам поднял certbot через CLI, либо после
   * переустановки панели с сохранёнными /etc/letsencrypt.
   *
   * Агент возвращает {found, certPath, keyPath, expiresAt}. Если файлы есть
   * и валидны — пишем в БД, статус ACTIVE, пересобираем nginx/php.
   */
  async importExistingCertificate(siteId: string, userId: string, role: string) {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      include: { sslCertificate: true },
    });
    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    if (!site.sslCertificate) {
      throw new BadRequestException('SSL certificate record not initialized');
    }
    if (!this.agentRelay.isAgentConnected()) {
      throw new BadRequestException('Agent is offline');
    }

    const result = await this.agentRelay.emitToAgent<{
      found: boolean;
      certPath?: string;
      keyPath?: string;
      expiresAt?: string;
      domains?: string[];
    }>('ssl:inspect-existing', { domain: site.domain }, 30_000);

    if (!result.success || !result.data?.found) {
      throw new BadRequestException(
        result.error || result.data && !result.data.found
          ? `На диске нет действующего сертификата для ${site.domain}`
          : 'Не удалось проверить сертификат на диске',
      );
    }

    await this.updateAfterIssuance(
      siteId,
      true,
      result.data.certPath,
      result.data.keyPath,
      result.data.expiresAt,
      "Let's Encrypt",
      result.data.domains,
    );

    this.logger.log(`SSL imported from disk for ${site.domain}`);
    return {
      imported: true,
      certPath: result.data.certPath,
      expiresAt: result.data.expiresAt,
    };
  }

  async installCustomCertificate(
    siteId: string,
    userId: string,
    role: string,
    certPem: string,
    keyPem: string,
    chainPem?: string,
  ) {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      include: { sslCertificate: true },
    });

    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    if (!site.sslCertificate) {
      throw new BadRequestException('SSL certificate record not initialized');
    }

    await this.prisma.sslCertificate.update({
      where: { siteId },
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
        domain: site.domain,
        certPem,
        keyPem,
        chainPem,
      });

      // Агент для `ssl:install-custom`, как и для `ssl:issue`, отдаёт плоский
      // SslResult без оборачивания в `data`.
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
          siteId,
          true,
          ack.certPath,
          ack.keyPath,
          ack.expiresAt,
          'Custom',
          ack.domains,
        );

        // updateAfterIssuance уже вызывает rebuildAgentArtifacts() (см. updateAfterIssuance),
        // который дёргает nginx:create-config с новыми SSL-параметрами.
        // Поэтому отдельный nginx:update-config с пустым config — был лишним
        // фейк-сообщением (пустая строка просто очистила бы 95-custom.conf).
        // Если по каким-то причинам rebuild не сработал — выше мы это уже залогируем.

        this.logger.log(`Custom SSL installed for ${site.domain}`);
        return { success: true };
      } else {
        await this.updateAfterIssuance(siteId, false);
        throw new BadRequestException(ack.error || raw.error || 'Custom SSL installation failed');
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      await this.updateAfterIssuance(siteId, false);
      throw new BadRequestException((err as Error).message);
    }
  }

  async checkExpirations() {
    const certs = await this.prisma.sslCertificate.findMany({
      where: {
        status: { in: [SslStatus.ACTIVE, SslStatus.EXPIRING_SOON] },
        expiresAt: { not: null },
      },
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

        // Notify on status change OR at milestone days (7, 3, 1, 0)
        const statusChanged = newStatus !== cert.status && (newStatus === SslStatus.EXPIRING_SOON || newStatus === SslStatus.EXPIRED);
        const isMilestone = [7, 3, 1, 0].includes(daysRemaining);
        if (statusChanged || isMilestone) {
          const site = await this.prisma.site.findUnique({
            where: { id: cert.siteId },
            select: { name: true, domain: true },
          });
          this.notifier.dispatch({
            event: 'SSL_EXPIRING',
            title: daysRemaining <= 0 ? 'SSL Certificate Expired' : `SSL Certificate Expires in ${daysRemaining} Day${daysRemaining === 1 ? '' : 's'}`,
            message: daysRemaining <= 0
              ? `SSL certificate for ${site?.domain || 'unknown'} has expired`
              : `SSL certificate for ${site?.domain || 'unknown'} expires in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`,
            siteName: site?.name,
            timestamp: new Date(),
          }).catch((err) => this.logger.error(`Notification failed: ${(err as Error).message}`));
        }
      }
    }
  }
}
