/**
 * Парсер /var/www/<user>/dumper.yaml — конфиг старого скрипта-дампера
 * (использовался hostPanel для бэкапов). Содержит:
 *   - DB-креды (fallback к hostpanel-таблице, если там пусто)
 *   - exclude paths (используются как auto-prefill для rsync)
 *
 * Не используем npm-yaml — формат тут плоский и предсказуемый, парсим
 * руками regex'ами. Спасает от лишней зависимости в агенте.
 */

export interface DumperYaml {
  enabled?: boolean;
  database?: {
    type?: string;
    host?: string;
    port?: number;
    name?: string;
    user?: string;
    pass?: string;
  };
  /** Сырые exclude-патерны (с ведущим слэшем — относительны home-dir сайта). */
  exclude: string[];
}

export function parseDumperYaml(raw: string): DumperYaml {
  const result: DumperYaml = { exclude: [] };

  // database: блок (отступ 4 пробела или таб)
  const dbBlockMatch = raw.match(/^database:\s*\n((?:[\t ]+\S.*\n?)+)/m);
  if (dbBlockMatch?.[1]) {
    const block = dbBlockMatch[1];
    result.database = {};
    const grab = (key: string) => {
      const m = block.match(new RegExp(`^[\\t ]+${key}:\\s*(.+?)\\s*$`, 'm'));
      return m ? m[1]!.replace(/^['"]|['"]$/g, '') : undefined;
    };
    result.database.type = grab('type');
    result.database.host = grab('host');
    const port = grab('port');
    if (port) result.database.port = Number(port);
    result.database.name = grab('name');
    result.database.user = grab('user');
    result.database.pass = grab('pass');
  }

  // enabled
  const enabledMatch = raw.match(/^enabled:\s*(true|false)\s*$/m);
  if (enabledMatch?.[1]) result.enabled = enabledMatch[1] === 'true';

  // exclude: [ ... ] — может быть однострочный или многострочный
  const excludeMatch = raw.match(/^exclude:\s*\[([\s\S]*?)\]\s*$/m);
  if (excludeMatch?.[1]) {
    const inner = excludeMatch[1];
    const items = inner
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter((s) => s.length > 0 && !s.startsWith('#'));
    result.exclude = items;
  }

  return result;
}
