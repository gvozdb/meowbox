/**
 * Парсер /var/www/<user>/config.xml — это файл MODX-инсталлера со snapshot'ом
 * исходных параметров установки (db creds, paths, manager-юзер). Используется
 * как 3-й fallback при discovery (после hostpanel-таблицы и dumper.yaml).
 *
 * Формат: плоский XML с парами <key>value</key>. Регексим — добавлять xml2js
 * ради этого расточительно.
 */

export interface ConfigXml {
  databaseType?: string;
  databaseServer?: string;
  database?: string;
  databaseUser?: string;
  databasePassword?: string;
  tablePrefix?: string;
  corePath?: string;
  contextMgrPath?: string;
  contextConnectorsPath?: string;
  contextWebPath?: string;
  cmsadmin?: string;
  cmspass?: string;
  cmsadminemail?: string;
}

function tag(raw: string, name: string): string | undefined {
  const re = new RegExp(`<${name}>([^<]*)</${name}>`);
  const m = raw.match(re);
  return m?.[1] ? m[1].trim() : undefined;
}

export function parseConfigXml(raw: string): ConfigXml {
  return {
    databaseType: tag(raw, 'database_type'),
    databaseServer: tag(raw, 'database_server'),
    database: tag(raw, 'database'),
    databaseUser: tag(raw, 'database_user'),
    databasePassword: tag(raw, 'database_password'),
    tablePrefix: tag(raw, 'table_prefix'),
    corePath: tag(raw, 'core_path'),
    contextMgrPath: tag(raw, 'context_mgr_path'),
    contextConnectorsPath: tag(raw, 'context_connectors_path'),
    contextWebPath: tag(raw, 'context_web_path'),
    cmsadmin: tag(raw, 'cmsadmin'),
    cmspass: tag(raw, 'cmspass'),
    cmsadminemail: tag(raw, 'cmsadminemail'),
  };
}
