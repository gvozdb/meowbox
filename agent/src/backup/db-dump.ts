import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';

import { CommandExecutor } from '../command-executor';

const DUMP_TIMEOUT_MS = 600_000;

/**
 * pg_dump конкретной БД в указанный файл.
 *
 * Особенность PostgreSQL на хосте: роль `postgres` использует peer-auth →
 * подключиться к ней можно ТОЛЬКО из OS-юзера `postgres`. Агент крутится под
 * root → `pg_dump -U postgres` без sudo упадёт с «Peer authentication failed».
 * Поэтому всегда оборачиваем в `sudo -u postgres`.
 *
 * Второе следствие: postgres-юзер не имеет прав писать в директорию вызывающего
 * (например `/var/meowbox/backups/*` принадлежит root) → дампим во временный
 * файл в `/tmp` (доступно postgres), затем под root копируем в outputPath и
 * чистим temp. copy+unlink вместо rename — потому что /tmp может быть на
 * отдельном tmpfs/устройстве (rename вернёт EXDEV).
 */
export async function pgDumpToFile(
  executor: CommandExecutor,
  dbName: string,
  outputPath: string,
  extraArgs: string[] = [],
): Promise<void> {
  const tmpFile = path.join(os.tmpdir(), `meowbox-pgdump-${randomBytes(8).toString('hex')}.sql`);
  const sudoArgs = ['-u', 'postgres', 'pg_dump', '-Fp', '-f', tmpFile, ...extraArgs, dbName];
  try {
    const r = await executor.execute('sudo', sudoArgs, {
      timeout: DUMP_TIMEOUT_MS,
      allowFailure: true,
    });
    if (r.exitCode !== 0) {
      throw new Error(`pg_dump failed for ${dbName}: ${r.stderr}`);
    }
    await fs.promises.copyFile(tmpFile, outputPath);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

/**
 * Залить дамп .sql в указанную PostgreSQL-БД через `psql -f`.
 *
 * Та же ловушка peer-auth → запуск через `sudo -u postgres`. Дополнительно
 * postgres-юзеру нужен доступ на чтение к sourcePath. Вызывающий обычно держит
 * файл в root-owned директории (0600/0700) → копируем в /tmp с правами 0644,
 * чтобы postgres гарантированно прочитал, а после restore зачищаем.
 *
 * extraArgs позволяют каллеру дописать флаги вроде `-v ON_ERROR_STOP=1`.
 */
export async function pgRestoreFromFile(
  executor: CommandExecutor,
  dbName: string,
  sourcePath: string,
  extraArgs: string[] = [],
): Promise<void> {
  const tmpFile = path.join(os.tmpdir(), `meowbox-pgrestore-${randomBytes(8).toString('hex')}.sql`);
  try {
    await fs.promises.copyFile(sourcePath, tmpFile);
    fs.chmodSync(tmpFile, 0o644);
    const r = await executor.execute('sudo', [
      '-u', 'postgres', 'psql', '-d', dbName, ...extraArgs, '-f', tmpFile,
    ], { timeout: DUMP_TIMEOUT_MS, allowFailure: true });
    if (r.exitCode !== 0) {
      throw new Error(`psql restore failed for ${dbName}: ${r.stderr}`);
    }
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

/**
 * Дамп одной БД в единый `.sql`-файл (используется и бэкапами, и restic).
 *
 * Семантика «таблицы с пропуском данных» (excludeTableData): пропускаются
 * ТОЛЬКО строки (INSERT), но НЕ структура. CREATE TABLE такой таблицы
 * выгружается всегда — иначе на восстановлении приложение упадёт на первом
 * обращении к несуществующей таблице.
 *
 * MariaDB/MySQL при наличии исключений — двухпроходно:
 *   Проход 1 (`--no-data`): структура ВСЕХ таблиц + routines + triggers.
 *     Список исключений к этому проходу НЕ применяется → пропустить CREATE
 *     физически невозможно. Пишется в outputPath.
 *   Проход 2 (`--no-create-info --skip-triggers` + `--ignore-table`): только
 *     INSERT'ы, кроме исключённых таблиц. Пишется во временный файл и
 *     потоково (без буферизации в RAM — дамп может быть гигабайтами)
 *     дописывается в конец outputPath. Порядок в файле: структура → данные.
 *
 * PostgreSQL: `pg_dump --exclude-table-data=<t>` — родной флаг, исключает
 *   ровно данные, CREATE TABLE остаётся. Один проход.
 */
export async function dumpDatabaseToFile(
  executor: CommandExecutor,
  name: string,
  type: string,
  outputPath: string,
  excludeTableData?: string[],
): Promise<void> {
  const excluded = excludeTableData?.length ? excludeTableData : [];

  if (type === 'POSTGRESQL') {
    const extra: string[] = [];
    for (const t of excluded) extra.push(`--exclude-table-data=${t}`);
    await pgDumpToFile(executor, name, outputPath, extra);
    return;
  }

  const cmd = type === 'MARIADB' ? 'mariadb-dump' : 'mysqldump';

  // Нет исключений — один полный проход (структура + данные всех таблиц).
  if (excluded.length === 0) {
    const args = [
      '-u', 'root',
      '--single-transaction', '--quick', '--routines', '--triggers',
      `--result-file=${outputPath}`, name,
    ];
    const r = await executor.execute(cmd, args, {
      timeout: DUMP_TIMEOUT_MS,
      allowFailure: true,
    });
    if (r.exitCode !== 0) {
      throw new Error(`${cmd} failed for ${name}: ${r.stderr}`);
    }
    return;
  }

  // Проход 1 — структура ВСЕХ таблиц (вкл. исключённые) → outputPath.
  const schemaArgs = [
    '-u', 'root',
    '--no-data', '--routines', '--triggers',
    `--result-file=${outputPath}`, name,
  ];
  const rSchema = await executor.execute(cmd, schemaArgs, {
    timeout: DUMP_TIMEOUT_MS,
    allowFailure: true,
  });
  if (rSchema.exitCode !== 0) {
    throw new Error(`${cmd} schema dump failed for ${name}: ${rSchema.stderr}`);
  }

  // Проход 2 — данные кроме исключённых таблиц → временный файл.
  const dataFile = `${outputPath}.data`;
  const dataArgs = [
    '-u', 'root',
    '--single-transaction', '--quick', '--no-create-info', '--skip-triggers',
  ];
  for (const t of excluded) dataArgs.push(`--ignore-table=${name}.${t}`);
  dataArgs.push(`--result-file=${dataFile}`, name);
  const rData = await executor.execute(cmd, dataArgs, {
    timeout: DUMP_TIMEOUT_MS,
    allowFailure: true,
  });
  if (rData.exitCode !== 0) {
    fs.rmSync(dataFile, { force: true });
    throw new Error(`${cmd} data dump failed for ${name}: ${rData.stderr}`);
  }

  // Дописываем данные после структуры — потоково, без загрузки в RAM.
  try {
    await new Promise<void>((resolve, reject) => {
      const rs = fs.createReadStream(dataFile);
      const ws = fs.createWriteStream(outputPath, { flags: 'a' });
      rs.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      rs.pipe(ws);
    });
  } finally {
    fs.rmSync(dataFile, { force: true });
  }
}
