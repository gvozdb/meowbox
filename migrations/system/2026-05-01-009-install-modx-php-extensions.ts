import type { SystemMigration } from './_types';
import { ensureOndrejYandexMirror } from './_ondrej-repo';

/**
 * Доставить MODX/PHP extensions для всех уже установленных PHP версий.
 *
 * РЕЗИЛЬЕНТНОСТЬ: один сетевой сбой apt не должен валить всю миграцию.
 * Расклад:
 *   - В самом начале — подключаем зеркало Yandex для ondrej/php (если не
 *     подключено). Делаем ЗДЕСЬ а не полагаемся на 005/007 — миграция 009
 *     лексикографически идёт ПЕРЕД 003-yandex-mirror, и на чистой установке
 *     без правок 005/007 (старый релиз) могла бы упасть из-за лежащего
 *     launchpad CDN. Helper идемпотентен — повторный вызов ничего не делает.
 *   - `apt-get update` — с retry (3 попытки, бэкофф 2s/5s/10s). Если все
 *     упали — продолжаем (вдруг локальный кеш ещё свежий).
 *   - Каждый пакет ставится ОТДЕЛЬНО, упавший — логируется WARN, остальные
 *     продолжаются. Миграция помечается OK; повторный запуск доставит
 *     недостающие (идемпотентно).
 *   - Если совсем не получилось ни одного пакета — миграция всё равно
 *     помечается OK (нечего ронять CI), но в конце логирует summary.
 */

interface RunCtx {
  log: (s: string) => void;
  exec: {
    runShell: (s: string) => Promise<{ stdout: string; stderr: string }>;
  };
  exists: (p: string) => Promise<boolean>;
  dryRun: boolean;
}

async function runWithRetry(
  ctx: RunCtx,
  cmd: string,
  label: string,
  maxRetries = 3,
): Promise<{ ok: boolean; stderr?: string }> {
  let lastErr = '';
  const delays = [2_000, 5_000, 10_000];
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await ctx.exec.runShell(cmd);
      return { ok: true };
    } catch (e) {
      lastErr = (e as Error).message;
      if (attempt < maxRetries) {
        ctx.log(`  ${label}: попытка ${attempt}/${maxRetries} упала, retry через ${delays[attempt - 1]}ms`);
        await new Promise((r) => setTimeout(r, delays[attempt - 1]));
      }
    }
  }
  return { ok: false, stderr: lastErr.slice(0, 300) };
}

const migration: SystemMigration = {
  id: '2026-05-01-009-install-modx-php-extensions',
  description: 'Доставить MODX/PHP extensions для всех уже установленных PHP версий (network-resilient)',

  async up(ctx) {
    if (!(await ctx.exists('/usr/bin/apt-get'))) {
      ctx.log('SKIP: apt-get не найден — поддерживается только Debian/Ubuntu');
      return;
    }

    const extensions = [
      'mysql',
      'mbstring',
      'curl',
      'zip',
      'xml',
      'gd',
      'intl',
      'bcmath',
      'opcache',
      'imagick',
    ];

    const { stdout } = await ctx.exec.runShell(
      "ls /etc/php 2>/dev/null | grep -E '^[0-9]+\\.[0-9]+$' | sort -V || true",
    );
    const versions = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

    if (versions.length === 0) {
      ctx.log('SKIP: установленные PHP версии не найдены в /etc/php');
      return;
    }

    if (ctx.dryRun) {
      ctx.log(`would ensure extensions [${extensions.join(', ')}] for PHP [${versions.join(', ')}]`);
      return;
    }

    // Подключаем зеркало Yandex для ondrej/php (на случай если launchpad лежит).
    // Идемпотентно — если уже подключено (через install.sh / 005 / 007 / 003),
    // helper это увидит и ничего не изменит. См. _ondrej-repo.ts.
    try {
      const { stdout: osOut } = await ctx.exec.runShell(
        '. /etc/os-release && echo "${ID:-unknown}|${VERSION_CODENAME:-}"',
      );
      const [distroId, codename] = osOut.trim().split('|');
      const mirror = await ensureOndrejYandexMirror(ctx, {
        distroId: distroId || '',
        codename: codename || '',
        doAptUpdate: false, // общий apt-get update будет ниже
      });
      ctx.log(`[ondrej-mirror Yandex] ${mirror.reason}`);
    } catch (e) {
      ctx.log(`WARN: ondrej yandex-mirror setup упал: ${(e as Error).message.slice(0, 200)}`);
    }

    // Все apt-команды внутри этой миграции форсят IPv4 явным флагом.
    // На сервере IPv6 может быть не маршрутизирован — apt пытается AAAA-host
    // и зависает таймаутом. ForceIPv4 решает это даже без глобального
    // drop-in (см. 2026-05-02-002-apt-force-ipv4) — миграция самодостаточна.
    const APT_OPTS =
      '-o Acquire::ForceIPv4=true ' +
      '-o Dpkg::Options::=--force-confdef ' +
      '-o Dpkg::Options::=--force-confold';

    // apt-get update — с retry. Не fail-stop: если всё упало, идём дальше
    // на локальном кеше (он мог быть свежий с прошлого update).
    const upd = await runWithRetry(
      ctx,
      `DEBIAN_FRONTEND=noninteractive apt-get update -qq -o Acquire::ForceIPv4=true`,
      'apt-get update',
    );
    if (!upd.ok) {
      ctx.log(`WARN: apt-get update упал после 3 попыток: ${upd.stderr}`);
      ctx.log('  продолжаем на локальном кеше (вдруг свежий)');
    }

    const dpkgStatusFormat = '${Status}';
    const summary: { ok: string[]; failed: string[]; unavailable: string[]; skipped: string[] } = {
      ok: [],
      failed: [],
      unavailable: [],
      skipped: [],
    };

    for (const version of versions) {
      for (const ext of extensions) {
        const pkg = `php${version}-${ext}`;

        // Уже установлен?
        const installed = await ctx.exec.runShell(
          `dpkg-query -W -f='${dpkgStatusFormat}' ${pkg} 2>/dev/null | grep -q 'install ok installed' && echo yes || true`,
        );
        if (installed.stdout.trim() === 'yes') {
          summary.skipped.push(pkg);
          continue;
        }

        // Доступен в apt? Если нет — это норма для опциональных модулей,
        // молча пропускаем (раньше был WARN, но без сети `apt-cache show`
        // возвращает "available" по локальному кешу — false-negative).
        const available = await ctx.exec.runShell(
          `apt-cache show ${pkg} >/dev/null 2>&1 && echo yes || true`,
        );
        if (available.stdout.trim() !== 'yes') {
          summary.unavailable.push(pkg);
          continue;
        }

        ctx.log(`Installing ${pkg}`);
        // Ставим строго по одному. Один пакет = одна fail-зона. Apt всё равно
        // докинет deps, но если конкретный пакет недоступен из-за сети — это
        // не помешает следующему пакету.
        const ins = await runWithRetry(
          ctx,
          `DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${APT_OPTS} ${pkg}`,
          `apt-get install ${pkg}`,
          3,
        );
        if (ins.ok) {
          summary.ok.push(pkg);
        } else {
          summary.failed.push(pkg);
          ctx.log(`  WARN: не удалось поставить ${pkg}: ${ins.stderr}`);
        }
      }

      // Если что-то поставили или уже стояло — рестартуем fpm, чтобы
      // подхватились extensions (если он запущен; не запущен — silent skip).
      await ctx.exec.runShell(
        `systemctl restart php${version}-fpm.service >/dev/null 2>&1 || true`,
      );
    }

    ctx.log('Summary:');
    ctx.log(`  installed:   ${summary.ok.length}${summary.ok.length ? ' (' + summary.ok.join(', ') + ')' : ''}`);
    ctx.log(`  already on:  ${summary.skipped.length}`);
    ctx.log(`  unavailable: ${summary.unavailable.length}${summary.unavailable.length ? ' (' + summary.unavailable.join(', ') + ')' : ''}`);
    ctx.log(`  failed:      ${summary.failed.length}${summary.failed.length ? ' (' + summary.failed.join(', ') + ')' : ''}`);
    if (summary.failed.length > 0) {
      ctx.log(
        '  ⚠ часть пакетов не поставилась — миграция помечена OK (повторный запуск доставит остальные)',
      );
    }
  },
};

export default migration;
