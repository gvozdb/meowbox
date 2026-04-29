import { ServiceCatalogEntry } from './service.types';

/**
 * Каталог всех известных панели сервисов. Расширяется при добавлении нового
 * хендлера: новая запись здесь + новый файл в handlers/.
 */
export const SERVICE_CATALOG: readonly ServiceCatalogEntry[] = [
  {
    key: 'mariadb',
    name: 'MySQL / MariaDB',
    description:
      'Реляционная БД (MySQL-совместимая). Стандарт для PHP-сайтов, MODX/Wordpress и т.п. unix_socket auth для root, без открытых TCP-портов наружу.',
    category: 'database',
    icon: 'database',
    scope: 'global',
    databaseTypes: ['MARIADB', 'MYSQL'],
    uninstallable: true,
  },
  {
    key: 'postgresql',
    name: 'PostgreSQL',
    description:
      'Объектно-реляционная БД с богатой поддержкой типов и JSONB. peer-auth для роли postgres, без TCP-listener наружу.',
    category: 'database',
    icon: 'database',
    scope: 'global',
    databaseTypes: ['POSTGRESQL'],
    uninstallable: true,
  },
  {
    key: 'manticore',
    name: 'Manticore Search',
    description:
      'Полнотекстовый поисковый движок. Создаёт RT-индексы через SQL — структуру задаёт код сайта.',
    category: 'search',
    icon: 'search',
    scope: 'per-site',
  },
  {
    key: 'redis',
    name: 'Redis',
    description:
      'In-memory key-value хранилище для кэша/сессий/очередей. Доступ через unix-socket — TCP отключён.',
    category: 'cache',
    icon: 'cache',
    scope: 'per-site',
  },
] as const;

/**
 * Возвращает scope сервиса, дефолтя на `per-site` для исторических записей
 * без явного поля. Не размазывай эту логику — используй только эту функцию.
 */
export function getServiceScope(entry: ServiceCatalogEntry): 'per-site' | 'global' {
  return entry.scope ?? 'per-site';
}

export function findServiceEntry(key: string): ServiceCatalogEntry | null {
  return SERVICE_CATALOG.find((s) => s.key === key) ?? null;
}
