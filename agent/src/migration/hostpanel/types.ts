/**
 * Re-export типов PlanItem на стороне агента. Дублируем определения, чтобы
 * не зависеть от api/ — agent должен компилироваться независимо. См. также
 * api/src/migration-hostpanel/plan-item.types.ts (в идеале — синхронизировать
 * через @meowbox/shared, но для простоты пока два копия).
 */

export interface PlanItemHomeFile {
  name: string;
  kind: 'file' | 'dir';
  bytes: number;
  checked: boolean;
}

export interface PlanItemCronJob {
  raw: string;
  schedule: string;
  command: string;
  fromUser: string;
  target: 'this-site' | 'system-root' | 'skip';
  noteStripped?: string;
}

export interface PlanItemPhpFpmSettings {
  pm: 'ondemand' | 'dynamic' | 'static';
  pmMaxChildren: number;
  uploadMaxFilesize: string;
  postMaxSize: string;
  memoryLimit: string;
  custom: string;
}

export interface PlanItemSslInfo {
  transfer: boolean;
  sourceLiveDir: string;
  sourceArchiveDir: string;
  sourceRenewalConf: string;
  domainsInCert: string[];
  /**
   * Снести стейл `/etc/letsencrypt/{live,archive}/{newDomain}` и
   * `renewal/{newDomain}.conf` перед копированием. Мастер выставляет true,
   * если в БД панели домен свободен — значит папки на slave orphan
   * (остатки после удаления сайта; `certbot revoke` фейлится на migrated
   * сертах). Без этого copy-ssl падает с «уже существует на slave».
   */
  forceCleanStaleLE?: boolean;
}

export interface PlanItem {
  sourceSiteId: number;
  sourceUser: string;
  sourceDomain: string;
  sourceWebroot: string;
  sourceCms: 'modx' | null;
  sourceCmsVersion: string;
  sourcePhpVersion: string;
  sourceMysqlPrefix: string;

  newName: string;
  newDomain: string;
  newAliases: string[];
  /**
   * Если true — все алиасы создаются с `redirect=true` (301 на главный домен).
   * Выставляется парсером nginx, когда на источнике обнаружен
   * `if ($host != $main_host) return 301 ...` (см. spec §7.2).
   */
  aliasesRedirectToMain: boolean;
  phpVersion: string;

  homeIncludes: PlanItemHomeFile[];
  rsyncExtraExcludes: string[];
  dbExcludeDataTables: string[];
  cronJobs: PlanItemCronJob[];
  ssl: PlanItemSslInfo | null;
  manticore: { enable: boolean };
  modxPaths: { connectorsDir: string; managerDir: string };
  phpFpm: PlanItemPhpFpmSettings;
  nginxCustomConfig: string;
  /**
   * HSTS detected на источнике (`add_header Strict-Transport-Security`).
   * Мастер пишет в `Site.nginxHsts` чтобы layered-генератор включил
   * 50-security шаблон при последующих regen'ах (spec §7.2).
   */
  nginxHsts: boolean;
  /**
   * Webroot относительно `/var/www/<newName>/` — берётся из nginx `root`
   * директивы или hostpanel.path (обычно `www`, но бывает `public_html`).
   * Spec §7.2: «root /var/www/X/www → filesRelPath = 'www'».
   */
  filesRelPath: string;

  fsBytes: number;
  dbBytes: number;

  warnings: string[];
  blockedReason?: string;
}

export interface DiscoveryResult {
  sourceMeta: {
    distroId: string;
    distroVersion: string;
    nginxVersion: string | null;
    mysqlVersion: string | null;
    phpVersionsInstalled: string[];
    manticoreInstalled: boolean;
    manticoreIndexes: string[];
  };
  sites: PlanItem[];
  /**
   * Снимок исходных строк hostpanel-таблицы (без полей mysql_pass / sftp_pass /
   * manager_pass — секреты в открытом виде в БД мастера не храним).
   * Ключ — sourceSiteId, значение — JSON-объект со всеми полями строки.
   * Мастер записывает в `hostpanel_migration_items.sourceData` (spec §3.2).
   */
  sourceRows: Record<number, Record<string, unknown>>;
  systemCronJobs: PlanItemCronJob[];
  warnings: string[];
}

/**
 * Shortlist — результат фазы 1 (быстрый probe). Содержит общую информацию
 * по серверу + лёгкий список сайтов. БЕЗ du -sb, БЕЗ размеров БД, БЕЗ
 * парсинга nginx/config.xml/dumper.yaml. Эти тяжёлые шаги переносятся на
 * фазу 2 (`runDeepProbeSelected`) — только по выбранным юзером сайтам.
 *
 * Цель — за ~10-30 секунд показать оператору сетку сайтов с галочками,
 * чтобы он отметил нужные перед полным probe'ом. На сервере со 100+ сайтами
 * это спасает от 30-минутного простоя ради миграции 1-2 сайтов.
 */
export interface ShortlistItem {
  sourceSiteId: number;
  sourceUser: string;
  sourceDomain: string;
  sourceName: string;        // hostpanel.name (ярлык, может быть «allGifts.kz»)
  sourceCms: 'modx' | null;
  sourceCmsVersion: string;
  sourcePhpVersion: string;
  sourceMysqlDb: string;     // показываем оператору, чтоб понимал что мигрируем
  /** suggested newName (sanitized из sourceUser) — оператор поправит на step3 */
  newName: string;
  /** suggested newDomain (= hostpanel.site) — поправится на step3 */
  newDomain: string;
  /** Дефолт галочки: true для «обычных» сайтов, false для Adminer/host. */
  defaultSelected: boolean;
  /** Грубая оценка размера www/ от `du -sh` — секунды. null если не успел. */
  fsBytesApprox: number | null;
  warnings: string[];
  blockedReason?: string;
}

export interface ShortlistResult {
  sourceMeta: DiscoveryResult['sourceMeta'];
  items: ShortlistItem[];
  /**
   * Снимок исходных строк hostpanel-таблицы (без секретов). Мастер сразу
   * пишет в hostpanel_migration_items.sourceData — не надо тащить во второй
   * фазе, экономия трафика.
   */
  sourceRows: Record<number, Record<string, unknown>>;
  /** Системные cron'ы root (без привязки к сайтам). Фронт показывает в Step 3. */
  systemCronJobs: PlanItemCronJob[];
  warnings: string[];
}

export interface MigrationSourceCreds {
  host: string;
  port: number;
  sshUser: string;
  sshPassword: string;
  mysqlHost: string;
  mysqlPort: number;
  mysqlUser: string;
  mysqlPassword: string;
  hostpanelDb: string;
  hostpanelTablePrefix: string;
}
