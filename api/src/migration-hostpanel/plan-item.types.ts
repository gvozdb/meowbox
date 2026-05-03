/**
 * PlanItem — описание миграции одного сайта со старой hostPanel.
 * Сериализуется в `hostpanel_migration_items.plan` как JSON.
 *
 * См. spec §6.3 в /opt/meowbox/docs/specs/2026-05-01-hostpanel-migration.md
 */

export interface PlanItemHomeFile {
  /** Имя файла/папки в /var/www/<sourceUser>/ */
  name: string;
  /** Тип: file | dir (показывается в UI иконкой). */
  kind: 'file' | 'dir';
  /** Размер в байтах (от du -sb). */
  bytes: number;
  /** Включать ли в rsync. */
  checked: boolean;
}

export interface PlanItemCronJob {
  /** Сырая строка из crontab источника. */
  raw: string;
  /** 5-полевое расписание. */
  schedule: string;
  /** Команда. */
  command: string;
  /** Где она была: root | <username>. */
  fromUser: string;
  /** Куда ехать: this-site | system-root | skip. */
  target: 'this-site' | 'system-root' | 'skip';
  /** Если есть префикс `sudo -u<user>` — после его зачистки. Информационно. */
  noteStripped?: string;
}

export interface PlanItemPhpFpmSettings {
  pm: 'ondemand' | 'dynamic' | 'static';
  pmMaxChildren: number;
  uploadMaxFilesize: string; // "100M"
  postMaxSize: string;
  memoryLimit: string;
  /** Сырой кастом-блок (директивы, что не упаковались в стандартные поля). */
  custom: string;
}

export interface PlanItemSslInfo {
  /** Переносить ли LE-папки с источника как есть. */
  transfer: boolean;
  /** Папки на источнике: live/<domain>, archive/<domain>, renewal/<domain>.conf */
  sourceLiveDir: string;
  sourceArchiveDir: string;
  sourceRenewalConf: string;
  /** Domains в LE-серте (для UI display). */
  domainsInCert: string[];
  /**
   * Снести стейл-папки `/etc/letsencrypt/live|archive/{newDomain}` и
   * `renewal/{newDomain}.conf` ПЕРЕД rsync-копированием. Выставляется мастером
   * непосредственно перед запуском item'а: true, если в БД панели нет ни Site,
   * ни SslCertificate с этим доменом → значит папки на slave — orphan, остатки
   * после удаления сайта (`certbot revoke` падает на migrated сертах из-за
   * account mismatch, и LE-артефакты остаются на диске). Без этого флага
   * copy-ssl фейлится с «уже существует на slave» и блокирует ремиграцию.
   *
   * НЕ хранится в БД — рассчитывается каждый раз перед run-item, чтобы
   * актуальное состояние БД учитывалось.
   */
  forceCleanStaleLE?: boolean;
}

export interface PlanItem {
  /** hostpanel modx_host_hostpanel_sites.id */
  sourceSiteId: number;

  /** ====== Source snapshot (read-only из hostpanel + /var/www) ====== */
  sourceUser: string;        // linux user на источнике (= hostpanel.user)
  sourceDomain: string;      // hostpanel.site
  sourceWebroot: string;     // hostpanel.path → /var/www/<u>/www/
  sourceCms: 'modx' | null;
  sourceCmsVersion: string;  // hostpanel.version
  sourcePhpVersion: string;  // hostpanel.php
  sourceMysqlPrefix: string; // hostpanel.mysql_table_prefix

  /** ====== Mapping (редактируется в Plan-таблице) ====== */
  newName: string;       // → Site.name (и Linux user, и DB name)
  newDomain: string;     // → Site.domain
  newAliases: string[];  // → Site.aliases (JSON-array строк)
  /**
   * Если true — все алиасы 301-редиректят на главный домен (выставляется
   * парсером nginx когда на источнике есть `if ($host != $main_host) return 301`).
   * См. spec §7.2.
   */
  aliasesRedirectToMain?: boolean;
  phpVersion: string;    // 1-в-1 sourcePhpVersion если поддерживается

  /** ====== Sub-selections для миграции ====== */
  /** Содержимое /var/www/<sourceUser>/ — что переносить. */
  homeIncludes: PlanItemHomeFile[];
  /** Дополнительные rsync exclude-патерны. */
  rsyncExtraExcludes: string[];
  /** Полные имена таблиц БД, у которых дампим только структуру (без данных). */
  dbExcludeDataTables: string[];
  /** Cron-задачи (расфильтровано из root + <user>). */
  cronJobs: PlanItemCronJob[];
  /** SSL-параметры (если на источнике есть LE-серт). */
  ssl: PlanItemSslInfo | null;
  /** Включить сервис Manticore у нового сайта. */
  manticore: { enable: boolean };
  /** Имена директорий MODX на источнике (для патчинга config.core.php). */
  modxPaths: {
    connectorsDir: string;  // 'connectors' | 'connectors_xxx'
    managerDir: string;     // 'manager' | 'adminka' | ...
  };
  /** Параметры PHP-FPM (берутся с источника). */
  phpFpm: PlanItemPhpFpmSettings;
  /**
   * Кастомный nginx-снипет, собранный парсером из source-конфигов
   * (HSTS, CSP, bot-блок, неопознанные директивы). Передаётся на agent
   * и записывается в `/etc/nginx/meowbox/{name}/95-custom.conf`.
   */
  nginxCustomConfig: string;
  /**
   * HSTS-флаг, извлечённый из source-конфигов (`add_header
   * Strict-Transport-Security`). Используется мастером для `Site.nginxHsts`
   * — иначе при regen layered-конфигом флаг будет сбрасываться (spec §7.2).
   */
  nginxHsts?: boolean;
  /**
   * Webroot относительно `Site.rootPath`. Извлекается из nginx `root`
   * директивы или hostpanel.path. Обычно `'www'`, но бывает `'public_html'`.
   * Используется в `applyNginxStage` и `Site.filesRelPath` (spec §7.2).
   */
  filesRelPath?: string;

  /** ====== Snapshot для отслеживания статуса в UI ====== */
  /** Размер /var/www/<sourceUser>/www в байтах (для прогресс-бара). */
  fsBytes: number;
  /** Размер БД в байтах. */
  dbBytes: number;

  /** ====== Status ====== */
  /** Ошибки/предупреждения: PHP не поддерживается, имя занято и т.п. */
  warnings: string[];
  /** Если CONFLICT/BLOCKED — причина для UI. */
  blockedReason?: string;
}

/**
 * Shortlist (Phase 1) — быстрый probe без тяжёлых per-site операций. Только
 * базовая инфа: список сайтов с флагами «выбран по умолчанию», без размеров
 * (или с грубыми из `du -sh`). Оператор отмечает галки → POST /:id/probe →
 * мастер запускает phase 2 (полный план).
 */
export interface ShortlistItem {
  sourceSiteId: number;
  sourceUser: string;
  sourceDomain: string;
  sourceName: string;
  sourceCms: 'modx' | null;
  sourceCmsVersion: string;
  sourcePhpVersion: string;
  sourceMysqlDb: string;
  newName: string;
  newDomain: string;
  defaultSelected: boolean;
  fsBytesApprox: number | null;
  warnings: string[];
  blockedReason?: string;
}

export interface ShortlistResult {
  sourceMeta: {
    distroId: string;
    distroVersion: string;
    nginxVersion: string | null;
    mysqlVersion: string | null;
    phpVersionsInstalled: string[];
    manticoreInstalled: boolean;
    manticoreIndexes: string[];
  };
  items: ShortlistItem[];
  sourceRows?: Record<number, Record<string, unknown>>;
  systemCronJobs: PlanItemCronJob[];
  warnings: string[];
}

/** Snapshot источника, отдаётся UI после Discovery (для рендера Plan-таблицы). */
export interface DiscoveryResult {
  sourceMeta: {
    distroId: string;
    distroVersion: string;
    nginxVersion: string | null;
    mysqlVersion: string | null;
    phpVersionsInstalled: string[];
    manticoreInstalled: boolean;
    manticoreIndexes: string[]; // полный список (без привязки к сайтам — общая плашка)
  };
  sites: PlanItem[];
  /**
   * Снимок исходных строк hostpanel-таблицы по sourceSiteId. Без полей
   * `mysql_pass` / `sftp_pass` / `manager_pass` — секреты в открытом виде
   * в БД мастера не храним (см. spec §3.2: «без паролей в открытом виде»).
   * Мастер сохраняет в `hostpanel_migration_items.sourceData`.
   */
  sourceRows?: Record<number, Record<string, unknown>>;
  /** Cron-задачи у root, что НЕ привязаны ни к одному сайту (отдельная секция Plan'а). */
  systemCronJobs: PlanItemCronJob[];
  /** Найденные дополнительные предупреждения (общие, не на конкретный сайт). */
  warnings: string[];
}
