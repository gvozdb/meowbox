/**
 * Список путей, которые **обычно** не имеет смысла бэкапить.
 *
 * Это НЕ allowlist — мы юзеру не запрещаем. Мы только показываем warning
 * с причиной. Юзер ставит `warningAcknowledged=true` и продолжает.
 *
 * См. docs/specs/2026-05-10-unified-backups.md §3.2.
 */

export interface WarnReason {
  code: string;
  message: string;
}

interface WarnRule {
  match: RegExp;
  code: string;
  message: string;
}

const RULES: WarnRule[] = [
  {
    match: /^\/$/,
    code: 'ROOT_FILESYSTEM',
    message: 'Бэкап корня ФС включает всё подряд (включая `/proc`, `/sys`, `/dev` ' +
      'и сам бэкап). Скорее всего, это не то, что нужно.',
  },
  {
    match: /^\/proc(\/|$)/,
    code: 'PSEUDO_FS',
    message: '`/proc` — pseudo-filesystem ядра, бэкап содержимого бессмыслен и сломается.',
  },
  {
    match: /^\/sys(\/|$)/,
    code: 'PSEUDO_FS',
    message: '`/sys` — pseudo-filesystem ядра, бэкап бессмыслен.',
  },
  {
    match: /^\/dev(\/|$)/,
    code: 'PSEUDO_FS',
    message: '`/dev` — устройства, бэкап бессмыслен и опасен (попытка прочитать device-node может зависнуть).',
  },
  {
    match: /^\/run(\/|$)/,
    code: 'RUNTIME_FS',
    message: '`/run` — runtime-state (PID-файлы, сокеты). Бэкап бесполезен.',
  },
  {
    match: /^\/tmp(\/|$)/,
    code: 'TEMP_FS',
    message: '`/tmp` — временные файлы, чистится при ребуте. Скорее всего, не нужен.',
  },
  {
    match: /^\/var\/cache(\/|$)/,
    code: 'CACHE_FS',
    message: '`/var/cache` — кеши apt/man/etc. Можно регенерить, бэкап тратит место.',
  },
  {
    match: /^\/var\/log(\/|$)/,
    code: 'LOG_FS',
    message: '`/var/log` — логи. Обычно ротируются journald/logrotate, бэкап тратит место. ' +
      'Если нужны логи для аудита — бэкапь конкретные сервисы.',
  },
  {
    match: /^\/var\/lib\/mysql(\/|$)/,
    code: 'DB_RAW_FILES',
    message: '`/var/lib/mysql` — сырые файлы MariaDB/MySQL. Бэкап на ходу даёт inconsistent ' +
      'state. Если хочешь бэкапить БД — используй per-site backup (там делается mysqldump).',
  },
  {
    match: /^\/var\/lib\/postgresql(\/|$)/,
    code: 'DB_RAW_FILES',
    message: '`/var/lib/postgresql` — сырые файлы PostgreSQL. Бэкап на ходу даёт inconsistent state. ' +
      'Используй pg_dump через per-site backup.',
  },
  {
    match: /^\/opt\/meowbox\/state\/data\/snapshots(\/|$)/,
    code: 'BACKUP_OF_BACKUPS',
    message: 'Бэкапить директорию снапшотов внутри бэкапа — рекурсия здравого смысла. Это ловушка размера.',
  },
  {
    match: /^\/opt\/meowbox\/releases(\/|$)/,
    code: 'RELEASES_FS',
    message: '`/opt/meowbox/releases/` — версионированные tarball-релизы, регенерируются по `make update`. ' +
      'Бэкап бесполезен и большой.',
  },
  {
    match: /^\/opt\/meowbox\/current(\/|$)/,
    code: 'SYMLINK_FS',
    message: '`/opt/meowbox/current/` — symlink на текущий релиз, бэкапить не имеет смысла. ' +
      'Резервируй `/opt/meowbox/state/` отдельно или используй PANEL_DATA конфиг.',
  },
];

/**
 * Возвращает массив предупреждений для пути. Пустой массив = путь "чистый".
 */
export function checkPathWarnings(path: string): WarnReason[] {
  const normalized = path.replace(/\/+$/, '') || '/';
  const reasons: WarnReason[] = [];
  for (const rule of RULES) {
    if (rule.match.test(normalized)) {
      reasons.push({ code: rule.code, message: rule.message });
    }
  }
  return reasons;
}

/**
 * Валидация формата пути: абсолютный, без `..`, `\0`, control chars.
 * Бросает на невалидном.
 */
export function assertValidPath(path: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('Путь не задан');
  }
  if (!path.startsWith('/')) {
    throw new Error('Путь должен быть абсолютным (начинаться с `/`)');
  }
  if (path.includes('..')) {
    throw new Error('Путь не должен содержать `..`');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path)) {
    throw new Error('Путь содержит управляющие символы');
  }
  if (path.length > 4096) {
    throw new Error('Путь слишком длинный (макс 4096)');
  }
}
