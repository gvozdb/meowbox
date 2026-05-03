import type { SystemMigration } from './_types';

/**
 * Поднимает серверные лимиты MariaDB, нужные для импорта больших дампов
 * (миграция сайтов с hostpanel: БД 10-20 GB, INSERT'ы > 16M, BLOB'ы и т.п.).
 *
 * Что меняем:
 *   - max_allowed_packet = 1G  (было 16M — резало extended-INSERT и BLOB-ы,
 *     из-за чего pipe-import зависал на середине)
 *   - net_read_timeout  = 600  (было 30 — на медленном диске import читал
 *     дамп дольше 30s между пакетами, сервер обрывал)
 *   - net_write_timeout = 600
 *
 * Записывает дроп-ин конфиг /etc/mysql/mariadb.conf.d/99-meowbox-import.cnf —
 * не трогает дефолтные файлы дистрибутива. После записи рестартует mariadb
 * (эти переменные требуют рестарта, SET GLOBAL не помогает для уже открытых
 * соединений).
 *
 * Идемпотентность: если конфиг уже на месте с теми же значениями — рестарта НЕ делаем.
 */

const DROPIN_PATH = '/etc/mysql/mariadb.conf.d/99-meowbox-import.cnf';
const DROPIN_CONTENT = `# Managed by meowbox migration 2026-05-02-001-mariadb-tune-import
# Не редактируй вручную — будет перезаписано следующим прогоном миграции.

[mysqld]
max_allowed_packet = 1G
net_read_timeout = 600
net_write_timeout = 600

[client]
max_allowed_packet = 1G
`;

const migration: SystemMigration = {
  id: '2026-05-02-001-mariadb-tune-import',
  description: 'MariaDB: max_allowed_packet=1G + net_*_timeout=600 для импорта больших дампов',

  async preflight(ctx) {
    // Без mariadb сервера/клиента миграции делать нечего — пусть будет early-fail.
    if (!(await ctx.exists('/etc/mysql'))) {
      return { ok: false, reason: '/etc/mysql отсутствует — MariaDB не установлен?' };
    }
    return { ok: true };
  },

  async up(ctx) {
    // 1. Идемпотентность: сравниваем содержимое.
    let needWrite = true;
    if (await ctx.exists(DROPIN_PATH)) {
      const cur = await ctx.readFile(DROPIN_PATH);
      if (cur === DROPIN_CONTENT) {
        ctx.log(`✓ ${DROPIN_PATH} уже содержит нужные значения, skip`);
        needWrite = false;
      } else {
        ctx.log(`▷ ${DROPIN_PATH} устарел (содержимое отличается), перезаписываем`);
      }
    } else {
      ctx.log(`▷ ${DROPIN_PATH} отсутствует, создаём`);
    }

    if (ctx.dryRun) {
      if (needWrite) ctx.log(`[dry-run] записал бы ${DROPIN_PATH}`);
      ctx.log(`[dry-run] systemctl restart mariadb`);
      return;
    }

    if (needWrite) {
      // 2. Атомарная запись — сначала во временный, потом mv. На случай падения
      // в середине: дефолтные файлы остаются нетронуты, mariadb стартует.
      const tmpPath = DROPIN_PATH + '.tmp';
      await ctx.writeFile(tmpPath, DROPIN_CONTENT, 0o644);
      await ctx.exec.run('mv', ['-f', tmpPath, DROPIN_PATH]);
      ctx.log(`  записал ${DROPIN_PATH} (${DROPIN_CONTENT.length} байт)`);
    }

    // 3. Проверяем серверные значения. Если уже совпадают — рестарт не нужен
    //    (например, конфиг был перезаписан в прошлой миграции с тем же
    //    содержимым, а рестарт уже произошёл). Делает миграцию повторно
    //    запускаемой без downtime.
    const before = await readMariadbVar(ctx, 'max_allowed_packet');
    const beforeNetR = await readMariadbVar(ctx, 'net_read_timeout');
    const beforeNetW = await readMariadbVar(ctx, 'net_write_timeout');
    ctx.log(
      `  текущее: max_allowed_packet=${before} bytes (${formatMb(before)}), net_read_timeout=${beforeNetR}s, net_write_timeout=${beforeNetW}s`,
    );
    const oneGb = 1024 * 1024 * 1024;
    const alreadyOk =
      before >= oneGb && beforeNetR >= 600 && beforeNetW >= 600;
    if (alreadyOk) {
      ctx.log(`✓ серверные значения уже корректные, рестарт не нужен`);
      return;
    }

    // 4. Рестарт mariadb. systemctl reload не подхватывает эти переменные —
    //    они только при init. Рестарт занимает 1-3 секунды, прода может
    //    моргнуть — это плата за расширение лимитов.
    ctx.log(`▷ systemctl restart mariadb (требуется чтобы значения вступили в силу)`);
    await ctx.exec.run('systemctl', ['restart', 'mariadb']);

    // 5. Verify after restart
    let after = 0;
    let afterNetR = 0;
    let afterNetW = 0;
    for (let i = 0; i < 30; i++) {
      try {
        after = await readMariadbVar(ctx, 'max_allowed_packet');
        afterNetR = await readMariadbVar(ctx, 'net_read_timeout');
        afterNetW = await readMariadbVar(ctx, 'net_write_timeout');
        if (after > 0) break;
      } catch {
        /* mariadb ещё не поднялась */
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (after < oneGb) {
      throw new Error(
        `После рестарта max_allowed_packet=${after} (ожидали ${oneGb}). Конфиг не подхватился — проверь /etc/mysql/mariadb.conf.d/`,
      );
    }
    ctx.log(
      `✓ после рестарта: max_allowed_packet=${formatMb(after)}, net_read_timeout=${afterNetR}s, net_write_timeout=${afterNetW}s`,
    );
  },

  async down(ctx) {
    if (await ctx.exists(DROPIN_PATH)) {
      if (ctx.dryRun) {
        ctx.log(`[dry-run] удалил бы ${DROPIN_PATH}`);
        return;
      }
      await ctx.exec.run('rm', ['-f', DROPIN_PATH]);
      ctx.log(`удалил ${DROPIN_PATH}`);
      ctx.log(`▷ systemctl restart mariadb`);
      await ctx.exec.run('systemctl', ['restart', 'mariadb']);
      ctx.log(`✓ откат завершён, серверные лимиты вернулись к дефолту`);
    }
  },
};

async function readMariadbVar(
  ctx: { exec: { run: (cmd: string, args: string[]) => Promise<{ stdout: string }> } },
  name: string,
): Promise<number> {
  // mysql -BN -e даёт "name<TAB>value\n", -BN убирает заголовок и форматирование
  const r = await ctx.exec.run('mysql', [
    '-BN',
    '-e',
    `SHOW VARIABLES LIKE '${name}'`,
  ]);
  const parts = r.stdout.trim().split(/\s+/);
  if (parts.length < 2) return 0;
  return Number(parts[1]) || 0;
}

function formatMb(bytes: number): string {
  if (bytes < 1024 * 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)}M`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}G`;
}

export default migration;
