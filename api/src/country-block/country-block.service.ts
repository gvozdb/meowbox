import {
  Injectable, NotFoundException, BadRequestException, ConflictException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { PanelSettingsService } from '../panel-settings/panel-settings.service';
import {
  CreateCountryBlockDto, UpdateCountryBlockDto, UpdateCountryBlockSettingsDto,
} from './country-block.dto';

export type CountrySource = 'IPDENY' | 'GITHUB_HERRBISCH';

export interface CountryBlockSettings {
  enabled: boolean;
  updateSchedule: string;
  primarySource: CountrySource;
  lastUpdate: string | null;
  lastUpdateError: string | null;
}

export interface AgentResult {
  success: boolean;
  error?: string;
  /** Информационный код для UI: 'NO_RULES' — нет правил для обновления и т.п. */
  info?: 'NO_RULES';
  applied?: number;
  errors?: string[];
  missingCountries?: string[];
  updated?: string[];
  ipsets?: Array<{ name: string; entries: number; family: 'v4' | 'v6' }>;
  countries?: Array<{ country: string; lastUpdate: string | null; v4Count: number; v6Count: number }>;
  iptablesActive?: boolean;
}

@Injectable()
export class CountryBlockService {
  private readonly logger = new Logger('CountryBlockService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
    private readonly panelSettings: PanelSettingsService,
  ) {}

  // ---------------------------------------------------------------------------
  // CRUD на правилах
  // ---------------------------------------------------------------------------

  async listRules() {
    return this.prisma.countryBlock.findMany({ orderBy: { createdAt: 'asc' } });
  }

  async createRule(dto: CreateCountryBlockDto) {
    const country = dto.country.toUpperCase();
    const ports = dto.ports?.trim() || null;
    const protocol = dto.protocol;

    // Уникальность по (country, ports, protocol) — БД не падает gracefully
    // при дубликате на SQLite, так что ручная проверка.
    const existing = await this.prisma.countryBlock.findFirst({
      where: { country, ports, protocol },
    });
    if (existing) {
      throw new ConflictException('Такое правило уже есть');
    }

    const rule = await this.prisma.countryBlock.create({
      data: {
        country,
        ports,
        protocol,
        enabled: dto.enabled !== false,
        comment: dto.comment?.trim() || null,
      },
    });

    // Применяем сразу, если master enabled и agent online
    await this.applyToAgentIfEnabled('после создания правила');
    return rule;
  }

  async updateRule(id: string, dto: UpdateCountryBlockDto) {
    const rule = await this.prisma.countryBlock.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException('Правило не найдено');

    const data: { ports?: string | null; protocol?: string; enabled?: boolean; comment?: string | null } = {};
    if (dto.ports !== undefined) data.ports = dto.ports?.trim() || null;
    if (dto.protocol !== undefined) data.protocol = dto.protocol;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.comment !== undefined) data.comment = dto.comment?.trim() || null;

    const updated = await this.prisma.countryBlock.update({ where: { id }, data });
    await this.applyToAgentIfEnabled('после изменения правила');
    return updated;
  }

  async removeRule(id: string) {
    const rule = await this.prisma.countryBlock.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException('Правило не найдено');
    await this.prisma.countryBlock.delete({ where: { id } });
    await this.applyToAgentIfEnabled('после удаления правила');
  }

  // ---------------------------------------------------------------------------
  // Settings (master switch + cron)
  // ---------------------------------------------------------------------------

  async getSettings(): Promise<CountryBlockSettings> {
    return this.panelSettings.get('country-block') as Promise<CountryBlockSettings>;
  }

  async updateSettings(dto: UpdateCountryBlockSettingsDto): Promise<CountryBlockSettings> {
    const cur = await this.getSettings();
    const next: CountryBlockSettings = {
      enabled: dto.enabled !== undefined ? dto.enabled : cur.enabled,
      updateSchedule: dto.updateSchedule !== undefined ? dto.updateSchedule : cur.updateSchedule,
      primarySource: (dto.primarySource as CountrySource) || cur.primarySource,
      lastUpdate: cur.lastUpdate,
      lastUpdateError: cur.lastUpdateError,
    };
    await this.panelSettings.set('country-block', next);

    // Если переключили мастер-свитч — сразу применяем (или чистим).
    if (cur.enabled !== next.enabled) {
      if (next.enabled) {
        await this.applyToAgent();
      } else {
        await this.clearOnAgent();
      }
    }
    return next;
  }

  // ---------------------------------------------------------------------------
  // Sync / Refresh / Status
  // ---------------------------------------------------------------------------

  /** Принудительная синхронизация правил из БД в агент. */
  async sync(): Promise<AgentResult> {
    return this.applyToAgent();
  }

  /** Принудительное обновление CIDR-базы. */
  async refreshDb(countries?: string[]): Promise<AgentResult> {
    if (!this.agentRelay.isAgentConnected()) {
      return { success: false, error: 'Agent offline' };
    }
    const settings = await this.getSettings();
    let list = countries?.map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
    if (!list || list.length === 0) {
      // Берём все страны из БД (учитываем и enabled=false — оператор мог временно
      // выключить, но всё равно ожидает что обновление CIDR'ов сработает).
      const rules = await this.prisma.countryBlock.findMany();
      list = Array.from(new Set(rules.map((r) => r.country.toUpperCase())));
    }
    if (list.length === 0) {
      // Нет правил — UI должен предложить сначала добавить страну.
      return { success: true, updated: [], info: 'NO_RULES' };
    }
    const sources = this.buildSources(settings.primarySource);

    // emitToAgent типизирован как AgentResponse<T>, но на руntime приходит
    // flat-структура (см. agent.service safeOn callback'и). Явный cast.
    const res = await this.agentRelay.emitToAgent('country-block:refresh-db', {
      countries: list,
      sources,
    }, 600_000) as unknown as AgentResult;

    // Записываем lastUpdate / lastUpdateError
    const cur = await this.getSettings();
    const errMsg = res.errors && res.errors.length > 0 ? `Ошибки: ${res.errors.length}` : null;
    await this.panelSettings.set('country-block', {
      ...cur,
      lastUpdate: new Date().toISOString(),
      lastUpdateError: res.success ? null : (errMsg || res.error || 'Unknown error'),
    });

    // После refresh — переприменяем правила (новые CIDR попадут в ipset'ы)
    if (cur.enabled && res.success) {
      await this.applyToAgent();
    }

    return res;
  }

  /** Текущее состояние с агента (ipset'ы, правила, даты обновления). */
  async getStatus(): Promise<AgentResult> {
    if (!this.agentRelay.isAgentConnected()) {
      return { success: false, error: 'Agent offline' };
    }
    return this.agentRelay.emitToAgent('country-block:status', {}, 30_000) as unknown as AgentResult;
  }

  // ---------------------------------------------------------------------------
  // Agent helpers
  // ---------------------------------------------------------------------------

  /**
   * Если master enabled — отправляет полный набор правил на agent для apply.
   * Если выключен — ничего не делаем (правила в БД, но не активны).
   */
  private async applyToAgentIfEnabled(reason: string): Promise<void> {
    const s = await this.getSettings();
    if (!s.enabled) return;
    try {
      const res = await this.applyToAgent();
      if (!res.success) {
        this.logger.warn(`country-block apply ${reason}: ${res.error || res.errors?.join('; ')}`);
      }
    } catch (e) {
      this.logger.warn(`country-block apply ${reason} failed: ${(e as Error).message}`);
    }
  }

  private async applyToAgent(): Promise<AgentResult> {
    if (!this.agentRelay.isAgentConnected()) {
      return { success: false, error: 'Agent offline' };
    }
    const rules = await this.prisma.countryBlock.findMany();
    const settings = await this.getSettings();
    const sources = this.buildSources(settings.primarySource);
    return this.agentRelay.emitToAgent('country-block:apply', {
      rules: rules.map((r) => ({
        country: r.country,
        ports: r.ports,
        protocol: r.protocol as 'TCP' | 'UDP' | 'BOTH',
        enabled: r.enabled,
      })),
      sources,
    }, 600_000) as unknown as AgentResult;
  }

  private async clearOnAgent(): Promise<AgentResult> {
    if (!this.agentRelay.isAgentConnected()) {
      return { success: false, error: 'Agent offline' };
    }
    return this.agentRelay.emitToAgent('country-block:clear', {}, 60_000) as unknown as AgentResult;
  }

  /**
   * Список источников: primary первым, остальные — fallback.
   * Используется агентом при downloadDataset() — пробует по очереди.
   */
  private buildSources(primary: CountrySource): CountrySource[] {
    const all: CountrySource[] = ['IPDENY', 'GITHUB_HERRBISCH'];
    return [primary, ...all.filter((s) => s !== primary)];
  }
}
