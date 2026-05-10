/**
 * Подготовка хоста к фиче «Блокировка по странам» (CountryBlockManager).
 *
 * Что нужно:
 *   1) Пакеты `ipset` и `iptables-persistent` (на Debian/Ubuntu).
 *      `iptables-persistent` ставит вместе с собой `netfilter-persistent`,
 *      который автоматически восстанавливает iptables-правила и ipset-сеты
 *      при ребуте.
 *   2) Каталог /var/lib/meowbox/geoip/ (0755) — в нём агент кеширует
 *      загруженные CIDR-zone'ы.
 *   3) Каталог /etc/iptables/ (0755) — туда `netfilter-persistent` пишет
 *      `rules.v4`, `rules.v6` и `ipset.rules`.
 *
 * Идемпотентно: проверяет наличие пакетов через `dpkg -s` и каталогов через
 * `fs.exists` перед каждой операцией.
 *
 * Совместимость:
 *   - Debian/Ubuntu: установка через apt-get.
 *   - Если в системе нет apt-get (rare, но возможно для slave на CentOS/Alpine) —
 *     миграция логирует warning и завершается без падения; админ должен
 *     поставить ipset вручную.
 */

import * as fsp from 'fs/promises';
import type { SystemMigration } from './_types';

const PACKAGES = ['ipset', 'iptables-persistent'];
const GEOIP_DIR = '/var/lib/meowbox/geoip';
const IPTABLES_DIR = '/etc/iptables';

const migration: SystemMigration = {
  id: '2026-05-10-001-install-ipset-iptables-persistent',
  description: 'Country-block: установить ipset+iptables-persistent, создать /var/lib/meowbox/geoip',

  async up(ctx) {
    // ============== 1) Каталог /var/lib/meowbox/geoip ==============
    if (!(await ctx.exists(GEOIP_DIR))) {
      if (ctx.dryRun) {
        ctx.log(`would: mkdir -p ${GEOIP_DIR} (mode 0755)`);
      } else {
        await fsp.mkdir(GEOIP_DIR, { recursive: true, mode: 0o755 });
        ctx.log(`создан ${GEOIP_DIR}`);
      }
    } else {
      ctx.log(`OK: ${GEOIP_DIR} существует`);
    }

    // ============== 2) Каталог /etc/iptables ==============
    if (!(await ctx.exists(IPTABLES_DIR))) {
      if (ctx.dryRun) {
        ctx.log(`would: mkdir -p ${IPTABLES_DIR} (mode 0755)`);
      } else {
        await fsp.mkdir(IPTABLES_DIR, { recursive: true, mode: 0o755 });
        ctx.log(`создан ${IPTABLES_DIR}`);
      }
    } else {
      ctx.log(`OK: ${IPTABLES_DIR} существует`);
    }

    // ============== 3) Проверка/установка пакетов ==============
    let aptAvailable = true;
    try {
      await ctx.exec.run('which', ['apt-get']);
    } catch {
      aptAvailable = false;
    }

    if (!aptAvailable) {
      ctx.log(
        'WARNING: apt-get не найден — пропускаю установку ipset/iptables-persistent.\n' +
        'Country-block работать не будет до тех пор, пока админ не поставит ipset вручную.',
      );
      return;
    }

    // Проверка пакетов через dpkg (без apt-cache, чтоб не лезть в сеть зря)
    const toInstall: string[] = [];
    for (const pkg of PACKAGES) {
      let installed = false;
      try {
        const r = await ctx.exec.run('dpkg', ['-s', pkg]);
        installed = r.stdout.includes('Status: install ok installed');
      } catch {
        installed = false;
      }
      if (!installed) toInstall.push(pkg);
    }

    if (toInstall.length === 0) {
      ctx.log('OK: все пакеты для country-block уже установлены');
      return;
    }

    if (ctx.dryRun) {
      ctx.log(`would: apt-get install -y ${toInstall.join(' ')}`);
      return;
    }

    ctx.log(`apt-get update && apt-get install -y ${toInstall.join(' ')}`);
    // DEBIAN_FRONTEND=noninteractive — иначе iptables-persistent спросит про
    // сохранение текущих правил при первой установке (зависает в noninteractive).
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DEBIAN_FRONTEND: 'noninteractive',
    };

    // apt-get update best-effort — если кеш свежий, не помешает; если нет —
    // install всё равно может пройти (зависит от sources.list).
    try {
      await ctx.exec.run('apt-get', ['update'], { env });
    } catch (err) {
      ctx.log(`apt-get update warning: ${(err as Error).message}`);
    }

    await ctx.exec.run(
      'apt-get',
      ['install', '-y', '--no-install-recommends', ...toInstall],
      { env },
    );
    ctx.log(`установлены: ${toInstall.join(', ')}`);

    // Включаем netfilter-persistent на boot (ставится самим пакетом, но на
    // некоторых образах servicestate=disabled).
    try {
      await ctx.exec.run('systemctl', ['enable', 'netfilter-persistent']);
      ctx.log('netfilter-persistent включён в автозапуск');
    } catch (err) {
      ctx.log(`warning: systemctl enable netfilter-persistent: ${(err as Error).message}`);
    }
  },
};

export default migration;
