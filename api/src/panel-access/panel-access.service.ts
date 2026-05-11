import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { PanelSettingsService } from '../panel-settings/panel-settings.service';
import { PrismaService } from '../common/prisma.service';

export interface PanelAccessSettings {
  domain: string | null;
  certMode: 'NONE' | 'SELFSIGNED' | 'LE';
  httpsRedirect: boolean;
  denyIpAccess: boolean;
  certIssuedAt: string | null;
  certExpiresAt: string | null;
  certPath: string | null;
  keyPath: string | null;
  leLastError: string | null;
  leEmail: string | null;
}

export interface PanelAccessStatus {
  /** Текущие настройки (как хранятся в БД). */
  settings: PanelAccessSettings;
  /** Live-данные от агента: фактическое состояние диска/DNS. */
  live: {
    /** Существует ли cert/key на диске прямо сейчас. */
    certOnDisk: boolean;
    /** Реальный notAfter из openssl (может отличаться от БД при ручных правках). */
    certExpiresAt: string | null;
    /** DNS A-резолв указанного domain (null если домен не задан). */
    dnsResolved: string | null;
    /** Публичный IP сервера (для сравнения с DNS-резолвом). */
    serverIp: string | null;
    /** Совпадает ли DNS A-record с публичным IP сервера. */
    dnsMatchesServer: boolean | null;
    /** Подключён ли агент. Если false — live-блок не наполняется. */
    agentOnline: boolean;
  };
}

const PANEL_DOMAIN_KEY = 'panel-access';

@Injectable()
export class PanelAccessService {
  private readonly logger = new Logger('PanelAccessService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PanelSettingsService,
    private readonly agentRelay: AgentRelayService,
  ) {}

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  async getStatus(): Promise<PanelAccessStatus> {
    const s = await this.settings.getPanelAccess();
    const live: PanelAccessStatus['live'] = {
      certOnDisk: false,
      certExpiresAt: null,
      dnsResolved: null,
      serverIp: null,
      dnsMatchesServer: null,
      agentOnline: this.agentRelay.isAgentConnected(),
    };

    if (live.agentOnline) {
      try {
        const ack = await this.agentRelay.emitToAgent<{
          certOnDisk: boolean;
          certExpiresAt: string | null;
          dnsResolved: string | null;
          serverIp: string | null;
          dnsMatchesServer: boolean | null;
        }>('panel-access:status', { domain: s.domain, certPath: s.certPath }, 10_000);
        const data = (ack as unknown) as Partial<typeof live> & { success?: boolean };
        if (data.success !== false) {
          live.certOnDisk = !!data.certOnDisk;
          live.certExpiresAt = data.certExpiresAt ?? null;
          live.dnsResolved = data.dnsResolved ?? null;
          live.serverIp = data.serverIp ?? null;
          live.dnsMatchesServer = data.dnsMatchesServer ?? null;
        }
      } catch (e) {
        this.logger.warn(`panel-access:status failed: ${(e as Error).message}`);
      }
    }

    return { settings: s, live };
  }

  // ---------------------------------------------------------------------------
  // Domain
  // ---------------------------------------------------------------------------

  async setDomain(domain: string | null): Promise<PanelAccessStatus> {
    const current = await this.settings.getPanelAccess();
    const normalized = (domain ?? '').trim().toLowerCase() || null;

    if (normalized && !this.isValidDomain(normalized)) {
      throw new BadRequestException('domain не валиден');
    }

    // Если домен изменился и текущий cert привязан к старому домену —
    // удаляем cert (нечего хранить серт от старого имени). Это исключает
    // ситуацию «домен сменили, на nginx остался старый LE серт».
    let next: PanelAccessSettings = { ...current, domain: normalized };
    if (normalized !== current.domain && current.certMode !== 'NONE') {
      this.logger.warn(
        `Domain changed (${current.domain} → ${normalized}). Сбрасываю текущий cert: certMode=NONE`,
      );
      // Сносим cert на диске через агент (если он есть).
      if (this.agentRelay.isAgentConnected() && current.certPath) {
        try {
          await this.agentRelay.emitToAgent('panel-access:remove-cert', {
            domain: current.domain,
            certPath: current.certPath,
            keyPath: current.keyPath,
            mode: current.certMode,
          }, 30_000);
        } catch (e) {
          this.logger.warn(`panel-access:remove-cert failed: ${(e as Error).message}`);
        }
      }
      next = {
        ...next,
        certMode: 'NONE',
        httpsRedirect: false,
        denyIpAccess: false,
        certIssuedAt: null,
        certExpiresAt: null,
        certPath: null,
        keyPath: null,
        leLastError: null,
      };
    }

    await this.settings.set(PANEL_DOMAIN_KEY, next);
    await this.applyNginx(next);
    return this.getStatus();
  }

  // ---------------------------------------------------------------------------
  // Behavior toggles (redirect, deny-ip)
  // ---------------------------------------------------------------------------

  async updateBehavior(
    httpsRedirect?: boolean,
    denyIpAccess?: boolean,
  ): Promise<PanelAccessStatus> {
    const current = await this.settings.getPanelAccess();

    const next: PanelAccessSettings = {
      ...current,
      httpsRedirect: httpsRedirect ?? current.httpsRedirect,
      denyIpAccess: denyIpAccess ?? current.denyIpAccess,
    };

    // Защита от bricking-конфига: нельзя включить denyIpAccess без валидного
    // cert и привязанного domain — иначе панель станет полностью недоступной.
    if (next.denyIpAccess) {
      if (!next.domain) {
        throw new BadRequestException('denyIpAccess требует привязанного domain');
      }
      if (next.certMode === 'NONE' || !next.certPath) {
        throw new BadRequestException('denyIpAccess требует выпущенного сертификата (LE или self-signed)');
      }
    }
    // Аналогично httpsRedirect: без cert редирект на https://… вернёт в никуда.
    if (next.httpsRedirect && next.certMode === 'NONE') {
      throw new BadRequestException('httpsRedirect требует выпущенного сертификата');
    }

    await this.settings.set(PANEL_DOMAIN_KEY, next);
    await this.applyNginx(next);
    return this.getStatus();
  }

  // ---------------------------------------------------------------------------
  // Cert: Let's Encrypt
  // ---------------------------------------------------------------------------

  async issueLeCert(email: string): Promise<PanelAccessStatus> {
    const current = await this.settings.getPanelAccess();
    if (!current.domain) {
      throw new BadRequestException('Сначала привяжите домен — LE выпускается только на DNS-имя');
    }
    if (!this.agentRelay.isAgentConnected()) {
      throw new BadRequestException('Агент офлайн — не могу выпустить cert');
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('email не валиден');
    }

    // Перед выпуском LE нужно убедиться, что nginx слушает :80 для
    // ACME challenge на webroot. applyNginx() с certMode=NONE и httpsRedirect=false
    // приведёт конфиг в state, где ACME пройдёт.
    await this.applyNginx({ ...current });

    try {
      const ack = await this.agentRelay.emitToAgent<{
        certPath?: string;
        keyPath?: string;
        expiresAt?: string;
        error?: string;
      }>('panel-access:issue-le', { domain: current.domain, email }, 180_000);

      const data = (ack as unknown) as {
        success?: boolean;
        certPath?: string;
        keyPath?: string;
        expiresAt?: string;
        error?: string;
      };

      if (data.success !== true) {
        const err = data.error || 'certbot не вернул success';
        const updated: PanelAccessSettings = {
          ...current,
          leEmail: email,
          leLastError: err,
        };
        await this.settings.set(PANEL_DOMAIN_KEY, updated);
        throw new BadRequestException(err);
      }

      const updated: PanelAccessSettings = {
        ...current,
        certMode: 'LE',
        certPath: data.certPath || null,
        keyPath: data.keyPath || null,
        certIssuedAt: new Date().toISOString(),
        certExpiresAt: data.expiresAt || null,
        leEmail: email,
        leLastError: null,
      };
      await this.settings.set(PANEL_DOMAIN_KEY, updated);
      await this.applyNginx(updated);
      return this.getStatus();
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const msg = (err as Error).message;
      const updated: PanelAccessSettings = {
        ...current,
        leEmail: email,
        leLastError: msg,
      };
      await this.settings.set(PANEL_DOMAIN_KEY, updated);
      throw new BadRequestException(msg);
    }
  }

  // ---------------------------------------------------------------------------
  // Cert: self-signed (только для IP-доступа — для домена должен быть LE)
  // ---------------------------------------------------------------------------

  async issueSelfSignedCert(): Promise<PanelAccessStatus> {
    const current = await this.settings.getPanelAccess();
    if (current.domain) {
      throw new BadRequestException(
        'Self-signed предназначен только для доступа по IP. Для домена используйте Let\'s Encrypt.',
      );
    }
    if (!this.agentRelay.isAgentConnected()) {
      throw new BadRequestException('Агент офлайн — не могу сгенерировать cert');
    }

    try {
      const ack = await this.agentRelay.emitToAgent<{
        certPath?: string;
        keyPath?: string;
        expiresAt?: string;
        cn?: string;
        error?: string;
      }>('panel-access:gen-selfsigned', { domain: null }, 60_000);

      const data = (ack as unknown) as {
        success?: boolean;
        certPath?: string;
        keyPath?: string;
        expiresAt?: string;
        error?: string;
      };

      if (data.success !== true) {
        throw new BadRequestException(data.error || 'не удалось сгенерировать self-signed cert');
      }

      const updated: PanelAccessSettings = {
        ...current,
        certMode: 'SELFSIGNED',
        certPath: data.certPath || null,
        keyPath: data.keyPath || null,
        certIssuedAt: new Date().toISOString(),
        certExpiresAt: data.expiresAt || null,
        leLastError: null,
      };
      await this.settings.set(PANEL_DOMAIN_KEY, updated);
      await this.applyNginx(updated);
      return this.getStatus();
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException((err as Error).message);
    }
  }

  // ---------------------------------------------------------------------------
  // Cert: remove
  // ---------------------------------------------------------------------------

  async removeCert(): Promise<PanelAccessStatus> {
    const current = await this.settings.getPanelAccess();
    if (current.certMode === 'NONE') {
      return this.getStatus();
    }

    if (this.agentRelay.isAgentConnected()) {
      try {
        await this.agentRelay.emitToAgent('panel-access:remove-cert', {
          domain: current.domain,
          certPath: current.certPath,
          keyPath: current.keyPath,
          mode: current.certMode,
        }, 30_000);
      } catch (e) {
        this.logger.warn(`panel-access:remove-cert failed: ${(e as Error).message}`);
      }
    }

    const updated: PanelAccessSettings = {
      ...current,
      certMode: 'NONE',
      certPath: null,
      keyPath: null,
      certIssuedAt: null,
      certExpiresAt: null,
      httpsRedirect: false,
      denyIpAccess: false,
      leLastError: null,
    };
    await this.settings.set(PANEL_DOMAIN_KEY, updated);
    await this.applyNginx(updated);
    return this.getStatus();
  }

  // ---------------------------------------------------------------------------
  // Default LE email — берём из профиля админа.
  // ---------------------------------------------------------------------------

  async getDefaultEmail(): Promise<string | null> {
    const s = await this.settings.getPanelAccess();
    if (s.leEmail) return s.leEmail;
    // Берём первого ADMIN-пользователя с заполненным email.
    const admin = await this.prisma.user.findFirst({
      where: { role: 'ADMIN', email: { not: '' } },
      orderBy: { createdAt: 'asc' },
      select: { email: true },
    });
    if (admin && admin.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(admin.email)) {
      return admin.email;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Internal: пнуть агента, чтобы перерисовал nginx-конфиг панели и сделал reload
  // ---------------------------------------------------------------------------

  private async applyNginx(s: PanelAccessSettings): Promise<void> {
    if (!this.agentRelay.isAgentConnected()) {
      this.logger.warn('Агент офлайн — nginx не перечитан, изменения вступят при следующем коннекте');
      return;
    }
    try {
      const ack = await this.agentRelay.emitToAgent<{ error?: string }>(
        'panel-access:render-nginx',
        {
          domain: s.domain,
          certMode: s.certMode,
          certPath: s.certPath,
          keyPath: s.keyPath,
          httpsRedirect: s.httpsRedirect,
          denyIpAccess: s.denyIpAccess,
        },
        30_000,
      );
      const data = (ack as unknown) as { success?: boolean; error?: string };
      if (data.success !== true) {
        throw new Error(data.error || 'agent panel-access:render-nginx did not return success');
      }
    } catch (e) {
      this.logger.error(`panel-access:render-nginx failed: ${(e as Error).message}`);
      throw new BadRequestException(`Не удалось применить конфиг nginx: ${(e as Error).message}`);
    }
  }

  private isValidDomain(d: string): boolean {
    if (d.length > 253 || d.includes('..')) return false;
    return /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(d);
  }
}
