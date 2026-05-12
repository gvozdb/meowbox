/**
 * Generic типы и интерфейсы подсистемы Сервисы.
 *
 * Архитектура:
 *   - ServerService (DB) — установлен ли сервис на сервере (apt-пакет, systemd unit-template).
 *   - SiteService (DB)   — активирован ли сервис для конкретного сайта; per-site инстанс.
 *   - ServiceHandler     — реализация конкретного сервиса (Manticore, Redis, ...).
 *
 * Каждый handler знает, как:
 *   - проверить/поставить пакет на сервер;
 *   - активировать/деактивировать инстанс для сайта;
 *   - стартануть/стопнуть демон сайта;
 *   - вернуть connection info, метрики, логи.
 */

export type SiteServiceStatus = 'STARTING' | 'RUNNING' | 'STOPPED' | 'ERROR';

/**
 * Область применения сервиса:
 *   - `per-site`  — есть отдельный инстанс на каждый сайт (Redis, Manticore).
 *                   Активируется/деактивируется на вкладке сайта «Сервисы».
 *   - `global`    — один общий демон на сервер для всех сайтов (MariaDB, PostgreSQL).
 *                   На вкладке сайта НЕ показывается. На странице /services есть
 *                   только Установить/Удалить, без per-site-конфига.
 *                   «Используется на N сайтах» считается через сущность Database
 *                   (а не SiteService).
 */
export type ServiceScope = 'per-site' | 'global';

export interface ServiceCatalogEntry {
  /** Системный ключ ('manticore', 'redis', 'mariadb', 'postgresql'). Используется в API и БД. */
  key: string;
  /** Человекочитаемое название ('Manticore Search'). */
  name: string;
  /** Краткое описание для UI. */
  description: string;
  /** Категория (для группировки в UI). */
  category: 'search' | 'cache' | 'queue' | 'database' | 'security' | 'mail' | 'other';
  /** Иконка (имя SVG из набора). */
  icon: string;
  /**
   * Область применения. По умолчанию `per-site` — это исторически Redis/Manticore.
   * Для глобальных сервисов вроде MariaDB/PostgreSQL ставь `global`.
   */
  scope?: ServiceScope;
  /**
   * Какие значения `Database.type` обслуживает этот сервис. Используется для
   * подсчёта «используется на N сайтах» у глобальных DB-сервисов и для
   * запрета удаления, если хотя бы одна БД ещё жива.
   * Пример: для `mariadb` — ['MARIADB', 'MYSQL'] (MySQL-обратная совместимость).
   * Для `postgresql` — ['POSTGRESQL'].
   * Для не-DB сервисов это поле опускается.
   */
  databaseTypes?: readonly string[];
  /** Можно ли удалить сервис через UI. По умолчанию true. */
  uninstallable?: boolean;
  /**
   * Системный сервис — поставляется с ОС (SSH-демон). Считаем установленным
   * всегда, кнопка «Установить» в UI исчезает, «Удалить» — заблокирована.
   * Управляем только конфигом + restart.
   */
  systemCore?: boolean;
}

export interface ServerServiceState {
  key: string;
  installed: boolean;
  version: string | null;
  installedAt: Date | null;
  lastError: string | null;
  /** Сколько сайтов активировали сервис. */
  sitesUsing: number;
}

export interface SiteServiceState {
  key: string;
  active: boolean;
  status: SiteServiceStatus;
  lastError: string | null;
  installedAt: Date | null;
  /** Per-site overrides (memoryMaxMb и т.п.). */
  config: Record<string, unknown>;
}

export interface ConnectionInfo {
  /** Список ключ-значений для копирования в код сайта. */
  items: Array<{ label: string; value: string; copyable?: boolean }>;
  /** Подсказка по использованию. */
  hint?: string;
}

export interface ServiceMetrics {
  /** Список (label, value) для UI. Пустой массив — метрик нет. */
  items: Array<{ label: string; value: string }>;
  /** Размер на диске, байт (для общей статистики). */
  diskBytes?: number;
  /** Uptime, сек. */
  uptimeSec?: number;
}

export interface SiteContext {
  id: string;
  name: string;
  systemUser: string;
  rootPath: string;
}
