/**
 * Установка GitHub CLI (gh) на существующих панелях.
 *
 * Что делает:
 *   1. Если gh уже стоит — skip.
 *   2. Иначе — добавляет официальный apt-репозиторий cli.github.com и ставит gh.
 *
 * Зачем:
 *   - tools/update.sh предпочитает `gh release download` (надёжнее curl,
 *     работает с приватными репо, проверяет attestation).
 *   - Старые установки (до v0.3.5) ставились без gh → fallback на curl.
 *
 * Идемпотентно: повторный запуск проверяет наличие gh и список репо.
 * Только Debian/Ubuntu: на других дистрибутивах логирует предупреждение.
 */

import type { SystemMigration } from './_types';

const migration: SystemMigration = {
  id: '2026-04-30-004-install-gh-cli',
  description: 'Установка GitHub CLI (gh) для tools/update.sh',

  async up(ctx) {
    // 1) Уже установлен?
    try {
      const { stdout } = await ctx.exec.run('gh', ['--version']);
      ctx.log(`OK: gh уже установлен — ${stdout.split('\n')[0].trim()}`);
      return;
    } catch {
      // нет — ставим
    }

    if (ctx.dryRun) {
      ctx.log('would install gh from cli.github.com apt repo');
      return;
    }

    // 2) Только Debian/Ubuntu (apt-get).
    if (!(await ctx.exists('/usr/bin/apt-get'))) {
      ctx.log('SKIP: apt-get не найден — установка gh поддерживается только на Debian/Ubuntu');
      return;
    }

    // 3) Ключ + репозиторий + установка. Скрипт для атомарности.
    ctx.log('Installing gh from cli.github.com apt repo...');
    const script = `
      set -e
      install -m 0755 -d /etc/apt/keyrings
      if [ ! -s /etc/apt/keyrings/githubcli-archive-keyring.gpg ]; then
        curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
          -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
        chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
      fi
      if [ ! -f /etc/apt/sources.list.d/github-cli.list ]; then
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
          > /etc/apt/sources.list.d/github-cli.list
      fi
      DEBIAN_FRONTEND=noninteractive apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \\
        -o Dpkg::Options::=--force-confdef \\
        -o Dpkg::Options::=--force-confold gh
    `;
    await ctx.exec.runShell(script);

    // 4) Проверка.
    try {
      const { stdout } = await ctx.exec.run('gh', ['--version']);
      ctx.log(`OK: gh установлен — ${stdout.split('\n')[0].trim()}`);
    } catch (e) {
      ctx.log(`WARN: gh не отвечает после установки: ${(e as Error).message}`);
    }
  },
};

export default migration;
