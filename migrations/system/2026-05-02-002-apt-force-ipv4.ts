import type { SystemMigration } from './_types';

/**
 * apt: форсим IPv4 для всех repo-операций.
 *
 * На сервере IPv6 не маршрутится (нет AAAA-route наружу), но многие
 * apt-зеркала (ppa.launchpadcontent.net, в частности) имеют AAAA-записи.
 * apt сначала пытается IPv6 → таймаут → падает с
 *   "Cannot initiate the connection ... (101: Network is unreachable)".
 *
 * Решение: drop-in `/etc/apt/apt.conf.d/99-meowbox-force-ipv4.conf` со
 * строкой `Acquire::ForceIPv4 "true";`. Apt подхватывает на каждом
 * запуске, рестарт ничего не нужен.
 */

const DROPIN_PATH = '/etc/apt/apt.conf.d/99-meowbox-force-ipv4.conf';
const DROPIN_CONTENT = `// Managed by meowbox migration 2026-05-02-002-apt-force-ipv4
// Apt должен использовать IPv4 — на сервере IPv6 не маршрутится наружу,
// иначе ppa.launchpadcontent.net и подобные ругаются Network is unreachable.
Acquire::ForceIPv4 "true";
`;

const migration: SystemMigration = {
  id: '2026-05-02-002-apt-force-ipv4',
  description: 'apt: форс IPv4 для repo-операций (фикс Network is unreachable на IPv6-only зеркалах)',

  async preflight(ctx) {
    if (!(await ctx.exists('/etc/apt/apt.conf.d'))) {
      return { ok: false, reason: '/etc/apt/apt.conf.d отсутствует — apt не установлен?' };
    }
    return { ok: true };
  },

  async up(ctx) {
    if (await ctx.exists(DROPIN_PATH)) {
      const cur = await ctx.readFile(DROPIN_PATH);
      if (cur === DROPIN_CONTENT) {
        ctx.log(`✓ ${DROPIN_PATH} уже на месте, skip`);
        return;
      }
      ctx.log(`▷ ${DROPIN_PATH} устарел, перезаписываем`);
    } else {
      ctx.log(`▷ создаём ${DROPIN_PATH}`);
    }

    if (ctx.dryRun) {
      ctx.log(`[dry-run] записал бы ${DROPIN_PATH}`);
      return;
    }
    await ctx.writeFile(DROPIN_PATH, DROPIN_CONTENT, 0o644);
    ctx.log(`✓ записал ${DROPIN_PATH} (apt подхватит на следующем запуске)`);
  },

  async down(ctx) {
    if (await ctx.exists(DROPIN_PATH)) {
      if (ctx.dryRun) {
        ctx.log(`[dry-run] удалил бы ${DROPIN_PATH}`);
        return;
      }
      await ctx.exec.run('rm', ['-f', DROPIN_PATH]);
      ctx.log(`✓ удалил ${DROPIN_PATH}`);
    }
  },
};

export default migration;
