import * as fs from 'fs';

import { CommandExecutor } from '../command-executor';

const DUMP_TIMEOUT_MS = 600_000;

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
    const args = ['-U', 'postgres', '-Fp', '-f', outputPath];
    for (const t of excluded) args.push(`--exclude-table-data=${t}`);
    args.push(name);
    const r = await executor.execute('pg_dump', args, {
      timeout: DUMP_TIMEOUT_MS,
      allowFailure: true,
    });
    if (r.exitCode !== 0) {
      throw new Error(`pg_dump failed for ${name}: ${r.stderr}`);
    }
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
