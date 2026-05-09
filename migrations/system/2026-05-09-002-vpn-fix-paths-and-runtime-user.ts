/**
 * Фиксит две проблемы которые были в первой версии VPN-флоу:
 *
 *   1) Системный юзер `meowbox-vpn` мог не существовать на хостах, где
 *      `installXray()` выполнялся до фикса контракта `CommandExecutor.execute`
 *      (`try { execute('id') } catch` никогда не срабатывал → `useradd` не
 *      вызывался → `xray.service` падал с `status=217/USER`).
 *
 *   2) AmneziaWG-конфиги писались в `/etc/amneziawg/*.conf`, а пакет
 *      `amneziawg-tools` (и юнит `awg-quick@.service`) ищет их в
 *      `/etc/amnezia/amneziawg/*.conf`. Из-за этого `awg-quick@<iface>`
 *      падал с "/etc/amnezia/amneziawg/<iface>.conf' does not exist".
 *
 * Что делает миграция:
 *   - Создаёт юзера `meowbox-vpn` (системный, /usr/sbin/nologin), если нет.
 *   - chown -R `meowbox-vpn` для существующих /opt/meowbox/state/vpn/<id>/.
 *   - Переносит /etc/amneziawg/awg-*.conf → /etc/amnezia/amneziawg/awg-*.conf
 *     (создавая директорию с правами 0700).
 *   - Перезапускает уже-существующие awg-quick@* и meowbox-vpn-xray-*
 *     юниты, чтобы они подхватили новый путь и юзера.
 *
 * Идемпотентно. Безопасно при повторном запуске.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import type { SystemMigration } from './_types';

const RUNTIME_USER = 'meowbox-vpn';
const OLD_AWG_DIR = '/etc/amneziawg';
const NEW_AWG_DIR = '/etc/amnezia/amneziawg';
const VPN_STATE_DIR = '/opt/meowbox/state/vpn';

const migration: SystemMigration = {
  id: '2026-05-09-002-vpn-fix-paths-and-runtime-user',
  description: 'VPN: создать meowbox-vpn user, перенести awg-confs в /etc/amnezia/amneziawg/',

  async up(ctx) {
    // ============== 1) Юзер meowbox-vpn ==============
    const idRes = await runAllowFail(ctx, '/usr/bin/id', [RUNTIME_USER]);
    if (idRes.code === 0) {
      ctx.log(`OK: юзер ${RUNTIME_USER} уже существует`);
    } else if (ctx.dryRun) {
      ctx.log(`would: useradd --system --no-create-home ${RUNTIME_USER}`);
    } else {
      await ctx.exec.run('/usr/sbin/useradd', [
        '--system',
        '--no-create-home',
        '--shell',
        '/usr/sbin/nologin',
        RUNTIME_USER,
      ]);
      ctx.log(`создан юзер ${RUNTIME_USER}`);
    }

    // ============== 2) chown стейт-папки Xray ==============
    if (await ctx.exists(VPN_STATE_DIR)) {
      if (ctx.dryRun) {
        ctx.log(`would: chown -R ${RUNTIME_USER}:${RUNTIME_USER} ${VPN_STATE_DIR}`);
      } else {
        await ctx.exec.run('chown', [
          '-R',
          `${RUNTIME_USER}:${RUNTIME_USER}`,
          VPN_STATE_DIR,
        ]);
        ctx.log(`chown ${VPN_STATE_DIR} → ${RUNTIME_USER}`);
      }
    } else {
      ctx.log(`skip chown: ${VPN_STATE_DIR} ещё не создан`);
    }

    // ============== 3) Перенос /etc/amneziawg/* → /etc/amnezia/amneziawg/* ==============
    if (!ctx.dryRun) {
      await fsp.mkdir(NEW_AWG_DIR, { recursive: true, mode: 0o700 });
      await fsp.chmod(NEW_AWG_DIR, 0o700);
    } else {
      ctx.log(`would: mkdir -p ${NEW_AWG_DIR} (mode 0700)`);
    }

    const movedConfs: string[] = [];
    if (await ctx.exists(OLD_AWG_DIR)) {
      let entries: string[] = [];
      try {
        entries = await fsp.readdir(OLD_AWG_DIR);
      } catch (err) {
        ctx.log(`не смог прочитать ${OLD_AWG_DIR}: ${(err as Error).message}`);
      }

      for (const entry of entries) {
        if (!/^awg-.+\.conf$/.test(entry)) continue;
        const src = path.join(OLD_AWG_DIR, entry);
        const dst = path.join(NEW_AWG_DIR, entry);

        // Уже мигрировано?
        if (await ctx.exists(dst)) {
          ctx.log(`skip: ${dst} уже существует — удалю исходник ${src}`);
          if (!ctx.dryRun) {
            try {
              await fsp.rm(src, { force: true });
            } catch {
              /* noop */
            }
          }
          continue;
        }

        if (ctx.dryRun) {
          ctx.log(`would: move ${src} → ${dst}`);
          continue;
        }

        // Атомарный rename работает только в пределах одного fs.
        // /etc и /etc/amnezia — один fs, так что ок.
        try {
          await fsp.rename(src, dst);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
            // Кросс-fs (мало вероятно для /etc) — fallback.
            const data = await fsp.readFile(src);
            await fsp.writeFile(dst, data, { mode: 0o600 });
            await fsp.rm(src, { force: true });
          } else {
            throw err;
          }
        }
        await fsp.chmod(dst, 0o600);
        movedConfs.push(entry);
        ctx.log(`moved ${src} → ${dst}`);
      }

      // Если /etc/amneziawg остался пустым — снесём, чтобы не путал в будущем.
      if (!ctx.dryRun) {
        try {
          const left = await fsp.readdir(OLD_AWG_DIR);
          if (left.length === 0) {
            await fsp.rmdir(OLD_AWG_DIR);
            ctx.log(`удалён пустой ${OLD_AWG_DIR}`);
          }
        } catch {
          /* noop */
        }
      }
    } else {
      ctx.log(`skip: ${OLD_AWG_DIR} не существует — мигрировать нечего`);
    }

    // ============== 4) Перезапуск уже существующих systemd-юнитов ==============
    if (movedConfs.length > 0) {
      if (ctx.dryRun) {
        ctx.log(`would: systemctl restart awg-quick@<iface> для ${movedConfs.length} юнитов`);
      } else {
        await runAllowFail(ctx, 'systemctl', ['daemon-reload']);
        for (const conf of movedConfs) {
          const iface = conf.replace(/\.conf$/, '');
          // reset-failed на случай если юнит был в failed-state до миграции.
          await runAllowFail(ctx, 'systemctl', ['reset-failed', `awg-quick@${iface}.service`]);
          const r = await runAllowFail(ctx, 'systemctl', ['restart', `awg-quick@${iface}.service`]);
          if (r.code !== 0) {
            ctx.log(`WARN: awg-quick@${iface} не стартанул: ${r.stderr.slice(0, 200)}`);
          } else {
            ctx.log(`перезапущен awg-quick@${iface}`);
          }
        }
      }
    }

    // Перезапускаем все meowbox-vpn-xray-*.service — чтобы 217/USER ушёл,
    // если до миграции юзера не было.
    const xrayUnits = await listXrayUnits(ctx);
    for (const unit of xrayUnits) {
      if (ctx.dryRun) {
        ctx.log(`would: systemctl restart ${unit}`);
        continue;
      }
      await runAllowFail(ctx, 'systemctl', ['reset-failed', unit]);
      const r = await runAllowFail(ctx, 'systemctl', ['restart', unit]);
      if (r.code !== 0) {
        ctx.log(`WARN: ${unit} не стартанул: ${r.stderr.slice(0, 200)}`);
      } else {
        ctx.log(`перезапущен ${unit}`);
      }
    }
  },
};

/**
 * Обёртка над `ctx.exec.run`, которая НЕ бросает при non-zero exit.
 * `MigrationContext.exec.run` бросает, поэтому ловим явно.
 */
async function runAllowFail(
  ctx: { exec: { run: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }> } },
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await ctx.exec.run(cmd, args);
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
    };
  }
}

async function listXrayUnits(ctx: { exec: { run: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }> } }): Promise<string[]> {
  const r = await runAllowFail(ctx, 'systemctl', [
    'list-unit-files',
    '--type=service',
    '--no-pager',
    '--no-legend',
    'meowbox-vpn-xray-*.service',
  ]);
  return r.stdout
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((n) => n && n.endsWith('.service'));
}

export default migration;
