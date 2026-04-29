import {
  ConnectionInfo,
  ServiceMetrics,
  SiteContext,
  SiteServiceStatus,
} from './service.types';

/**
 * Контракт реализации конкретного сервиса.
 *
 * Все методы вызываются из ServicesService. Хендлер общается с агентом через
 * AgentRelayService (передаётся в конструкторе) и не лезет в БД напрямую.
 */
export interface ServiceHandler {
  readonly key: string;

  // ---- Server level ----
  /** Установлен ли пакет/демон на сервере. */
  isInstalledOnServer(): Promise<{ installed: boolean; version: string | null }>;
  installOnServer(): Promise<{ version: string }>;
  uninstallFromServer(): Promise<void>;

  // ---- Site level ----
  /** Активировать сервис для сайта (создаёт data_dir, systemd unit, запускает). */
  enableForSite(site: SiteContext, config: Record<string, unknown>): Promise<void>;
  /** Полностью убрать сервис у сайта (стопнуть демон, удалить data_dir, env-файлы). */
  disableForSite(site: SiteContext): Promise<void>;

  /** Тогглы. Не удаляют данные — только стартуют/стопают демон. */
  startForSite(site: SiteContext): Promise<void>;
  stopForSite(site: SiteContext): Promise<void>;

  /** Текущий рантайм-статус демона сайта (через systemctl is-active и т.п.). */
  statusForSite(site: SiteContext): Promise<SiteServiceStatus>;

  /** Метрики (опционально, может вернуть пустой набор). */
  metricsForSite(site: SiteContext): Promise<ServiceMetrics>;

  /** Connection info — что копировать в код сайта. */
  connectionInfoForSite(site: SiteContext): ConnectionInfo;

  /** Логи демона. Возвращает последние N строк. */
  logsForSite(site: SiteContext, lines?: number): Promise<string>;

  /**
   * Применить config-overrides без полного reinstall (memory limit и т.п.).
   * Если хендлер этого не поддерживает — кидает Error.
   */
  reconfigureForSite(site: SiteContext, config: Record<string, unknown>): Promise<void>;
}
