import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

/**
 * Список валидных id палитр. ВАЖНО: должен совпадать с PALETTE_OPTIONS
 * в `web/composables/usePalette.ts` — иначе фронт сможет послать новый id,
 * а бэк его отбросит при валидации (BadRequest), либо наоборот пропустит,
 * а getAppearance() отфильтрует. Любые изменения — синхронизируй обе точки.
 */
export const VALID_PALETTES = [
  'amber',
  'violet',
  'emerald',
  'sapphire',
  'rose',
  'teal',
  'fuchsia',
] as const;
export type PaletteId = (typeof VALID_PALETTES)[number];

export function isValidPalette(v: unknown): v is PaletteId {
  return typeof v === 'string' && (VALID_PALETTES as readonly string[]).includes(v);
}

/**
 * KV-стор глобальных настроек панели.
 * Значения хранятся в SQLite как JSON-строки и парсятся при чтении.
 *
 * Ключи:
 *   - `general`        — мониторинг, сессии (ТТЛ/лимиты)
 *   - `site-defaults`  — дефолты формы создания сайта + пути хранения файлов
 *   - `backup-defaults`— авто-бэкапы: расписание, хранилище, retention
 *   - `appearance`     — внешний вид панели: цветовая гамма (palette)
 *   - `admin-ip-allowlist` — IP allowlist доступа в панель (по умолчанию выключен)
 */
@Injectable()
export class PanelSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly defaults = {
    general: {
      healthCheckIntervalSec: 60,
      alertCpuPercent: 85,
      alertRamPercent: 85,
      alertDiskPercent: 90,
      sessionMaxAttempts: 5,
      sessionAccessTtlMinutes: 15,
      sessionRefreshTtlDays: 7,
    },
    'site-defaults': {
      // Базовый путь, в котором для каждого сайта создаётся home-директория юзера.
      // Структура: `{sitesBasePath}/{safeName}/{siteFilesRelativePath}` — здесь лежат файлы сайта.
      sitesBasePath: '/var/www',
      // Относительный путь внутри home-директории, куда укладываются сами файлы сайта (nginx root).
      siteFilesRelativePath: 'www',
      // Дефолты формы создания сайта
      defaultPhpVersion: '8.2',
      defaultDbType: 'MARIADB',
      defaultAutoSsl: false,
      defaultHttpsRedirect: true,
    },
    // Глобальные настройки авто-бэкапов (применяются ко всем сайтам,
    // если per-site BackupConfig отсутствует).
    // engine:             TAR | RESTIC (по умолчанию RESTIC — дедупликация)
    // storageLocationIds: список StorageLocation.id — в каждое из них уедет бэкап
    // retention:          для RESTIC — keep-daily/weekly/monthly/yearly
    // retentionDays:      для TAR — кол-во бэкапов, которые держим (legacy)
    'backup-defaults': {
      enabled: false,
      schedule: '0 3 * * *',
      engine: 'RESTIC' as 'TAR' | 'RESTIC',
      type: 'FULL' as 'FULL' | 'FILES_ONLY' | 'DB_ONLY',
      storageLocationIds: [] as string[],
      retention: {
        keepDaily: 7,
        keepWeekly: 4,
        keepMonthly: 6,
        keepYearly: 1,
      },
      retentionDays: 14,
      excludePaths: [] as string[],
      excludeTableData: [] as string[],
      // Плановый `restic check` (verify repo integrity):
      //   checkEnabled       — включить плановую проверку
      //   checkSchedule      — cron (по умолчанию — еженедельно, вс в 04:00)
      //   checkReadData      — делать ли `--read-data`/subset (дорого, но надёжно)
      //   checkReadDataSubset— выборка для --read-data-subset (например "10%")
      //   checkMinIntervalHours — не запускать чаще чем раз в N часов на репу
      checkEnabled: false,
      checkSchedule: '0 4 * * 0',
      checkReadData: false,
      checkReadDataSubset: '10%',
      checkMinIntervalHours: 20,
    },
    // Внешний вид панели:
    //   palettes — карта { serverId → палитра }. Хранится только на мастере;
    //   /servers и /settings всегда пишут сюда (slave не участвует, чтобы фича
    //   работала даже когда slave старой версии и не знает /panel-settings/appearance).
    appearance: {
      palettes: {} as Record<string, PaletteId>,
    },
    // Server-level GeoIP-блокировка стран (см. CountryBlockManager на агенте).
    //   enabled            — мастер-свитч (false → агент сносит все правила)
    //   updateSchedule     — cron daily для обновления CIDR-базы (default 04:00)
    //   primarySource      — primary источник (IPDENY | GITHUB_HERRBISCH)
    //   lastUpdate         — ISO-таймстамп последнего успешного refresh-а
    //   lastUpdateError    — последняя ошибка refresh (если есть)
    'country-block': {
      enabled: false,
      updateSchedule: '0 4 * * *',
      primarySource: 'IPDENY' as 'IPDENY' | 'GITHUB_HERRBISCH',
      lastUpdate: null as string | null,
      lastUpdateError: null as string | null,
    },
    // Доступ к панели: домен, HTTPS-сертификат, редиректы, ограничения по IP.
    //
    //   domain          — DNS-имя, привязанное к панели. Если null/'' — панель
    //                     доступна только по IP:PORT, HTTPS не выпускается.
    //   certMode        — NONE: HTTP only;
    //                     SELFSIGNED: self-signed (только для IP-доступа);
    //                     LE: Let's Encrypt (требует domain).
    //   httpsRedirect   — слать 301 http://… → https://… на основной URL.
    //                     Имеет смысл только при certMode != NONE.
    //   denyIpAccess    — при привязанном domain закрыть доступ через IP:PORT
    //                     (server_name только domain; default_server → 444).
    //                     Требует валидный cert на domain.
    //   certIssuedAt    — ISO дата выпуска текущего серта (для UI).
    //   certExpiresAt   — ISO дата истечения (для UI; чтение из openssl).
    //   certPath/keyPath— абсолютные пути на диске. Заполняет агент при выпуске.
    //   leLastError     — текст последней ошибки certbot (для дебага в UI).
    //   leEmail         — email регистрации в LE (для подстановки в форму).
    'panel-access': {
      domain: null as string | null,
      certMode: 'NONE' as 'NONE' | 'SELFSIGNED' | 'LE',
      httpsRedirect: false,
      denyIpAccess: false,
      certIssuedAt: null as string | null,
      certExpiresAt: null as string | null,
      certPath: null as string | null,
      keyPath: null as string | null,
      leLastError: null as string | null,
      leEmail: null as string | null,
    },
  } as const;

  async get<T>(key: keyof typeof this.defaults): Promise<T> {
    const row = await this.prisma.panelSetting.findUnique({ where: { key } });
    const fallback = this.defaults[key];
    if (!row) return fallback as unknown as T;
    try {
      const parsed = JSON.parse(row.value);
      return { ...(fallback as object), ...parsed } as T;
    } catch {
      return fallback as unknown as T;
    }
  }

  async set(key: keyof typeof this.defaults, value: unknown): Promise<void> {
    const json = JSON.stringify(value);
    await this.prisma.panelSetting.upsert({
      where: { key },
      create: { key, value: json },
      update: { value: json },
    });
  }

  // Шорткаты для типизации в сервисах:
  async getSiteDefaults(): Promise<{
    sitesBasePath: string;
    siteFilesRelativePath: string;
    defaultPhpVersion: string;
    defaultDbType: string;
    defaultAutoSsl: boolean;
    defaultHttpsRedirect: boolean;
  }> {
    return this.get('site-defaults');
  }

  async getBackupDefaults(): Promise<{
    enabled: boolean;
    schedule: string;
    engine: 'TAR' | 'RESTIC';
    type: 'FULL' | 'FILES_ONLY' | 'DB_ONLY';
    storageLocationIds: string[];
    retention: {
      keepDaily: number;
      keepWeekly: number;
      keepMonthly: number;
      keepYearly: number;
    };
    retentionDays: number;
    excludePaths: string[];
    excludeTableData: string[];
    checkEnabled: boolean;
    checkSchedule: string;
    checkReadData: boolean;
    checkReadDataSubset: string;
    checkMinIntervalHours: number;
  }> {
    return this.get('backup-defaults');
  }

  /**
   * Палитры всех известных серверов. Старая форма `{ palette: 'amber' }`
   * (одиночная, до redesign'а) транслируется в `{ palettes: { main: ... } }`,
   * чтобы апгрейд панели не сбрасывал выбранную мастер-гамму.
   */
  async getAppearance(): Promise<{ palettes: Record<string, PaletteId> }> {
    const row = await this.prisma.panelSetting.findUnique({ where: { key: 'appearance' } });
    if (!row) return { palettes: {} };
    let raw: unknown;
    try {
      raw = JSON.parse(row.value);
    } catch {
      return { palettes: {} };
    }
    const obj = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {});
    const palettes: Record<string, PaletteId> = {};
    if (obj.palettes && typeof obj.palettes === 'object') {
      for (const [k, v] of Object.entries(obj.palettes as Record<string, unknown>)) {
        if (isValidPalette(v)) palettes[k] = v;
      }
    }
    // Legacy миграция: { palette: 'amber' } → palettes.main
    if (isValidPalette(obj.palette)) {
      if (!palettes.main) palettes.main = obj.palette;
    }
    return { palettes };
  }

  /** Установить палитру одного сервера (мерж в карту). */
  async setServerPalette(serverId: string, palette: PaletteId): Promise<{ palettes: Record<string, PaletteId> }> {
    const current = await this.getAppearance();
    current.palettes[serverId] = palette;
    await this.set('appearance', { palettes: current.palettes });
    return current;
  }

  // ── Panel access (домен, HTTPS, редиректы, IP-блок) ─────────────────────
  async getPanelAccess(): Promise<{
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
  }> {
    return this.get('panel-access');
  }
}
