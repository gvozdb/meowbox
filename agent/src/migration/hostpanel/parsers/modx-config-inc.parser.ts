/**
 * Парсер /var/www/<user>/www/core/config/config.inc.php — главный конфиг MODX,
 * содержит АКТУАЛЬНЫЕ db-креды и table_prefix (могут отличаться от того, что
 * в hostpanel прописано — например, после ручной правки или восстановления).
 *
 * Используется как 1-й приоритет при определении dbName / dbUser / table_prefix.
 *
 * Формат: PHP-define-блок. Парсим регексом — без PHP runtime'а.
 */

export interface ModxConfigInc {
  dbtype?: string;          // mysql | pgsql
  databaseServer?: string;  // host
  dbase?: string;           // database name
  databaseUser?: string;
  databasePassword?: string;
  tablePrefix?: string;
  basePath?: string;
  baseUrl?: string;
  managerPath?: string;
  managerUrl?: string;
  connectorsPath?: string;
  connectorsUrl?: string;
}

function defineValue(raw: string, name: string): string | undefined {
  // $database_server = 'localhost'; либо $modx_database_server = '...';
  // либо define('database_server', '...'); — пробуем все варианты.
  const patterns = [
    new RegExp(`\\$${name}\\s*=\\s*['"]([^'"\\\\]*(?:\\\\.[^'"\\\\]*)*)['"]\\s*;`),
    new RegExp(`\\$modx_${name}\\s*=\\s*['"]([^'"\\\\]*(?:\\\\.[^'"\\\\]*)*)['"]\\s*;`),
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

export function parseModxConfigInc(raw: string): ModxConfigInc {
  return {
    dbtype: defineValue(raw, 'dbtype'),
    databaseServer: defineValue(raw, 'database_server'),
    dbase: defineValue(raw, 'dbase'),
    databaseUser: defineValue(raw, 'database_user'),
    databasePassword: defineValue(raw, 'database_password'),
    tablePrefix: defineValue(raw, 'table_prefix'),
    basePath: defineValue(raw, 'base_path'),
    baseUrl: defineValue(raw, 'base_url'),
    managerPath: defineValue(raw, 'manager_path'),
    managerUrl: defineValue(raw, 'manager_url'),
    connectorsPath: defineValue(raw, 'connectors_path'),
    connectorsUrl: defineValue(raw, 'connectors_url'),
  };
}
