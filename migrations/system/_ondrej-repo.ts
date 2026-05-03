/**
 * Shared helper: подключение fallback-зеркала Yandex для ondrej/php PPA.
 *
 * Зачем:
 *   ondrej/php лежит на Canonical Launchpad (`ppa.launchpadcontent.net`).
 *   Этот CDN периодически отдаёт 503 и виснет на сутки+ (см. оператив 2026-05-02
 *   и историю в `oerdnj/deb.sury.org#2102`). Зеркало
 *   `https://mirror.yandex.ru/mirrors/launchpad/ondrej/php/` синхронизирует
 *   тот же репозиторий и исторически стабильнее. Подключаем его как
 *   ДОПОЛНИТЕЛЬНЫЙ источник — apt сам выберет доступный/быстрый.
 *
 * Где используется:
 *   - install.sh (на первой установке)
 *   - migrations/system/2026-04-30-005-install-php-versions.ts
 *   - migrations/system/2026-05-01-007-legacy-php-repo-bootstrap.ts
 *   - migrations/system/2026-05-02-003-ondrej-php-yandex-mirror.ts (для существующих панелей)
 *
 * Идемпотентно: проверяет существование `.sources`-файла и keyring перед
 * перезаписью. Совместимо с deb822-форматом, который использует
 * `add-apt-repository ppa:ondrej/php` начиная с Ubuntu 22.04+.
 */

import type { MigrationContext } from './_types';

/** Поддерживаемые зеркалом Yandex кодовые имена Ubuntu. */
const YANDEX_SUPPORTED_CODENAMES = new Set([
  'bionic',  // 18.04
  'focal',   // 20.04
  'jammy',   // 22.04
  'noble',   // 24.04
  'oracular',// 24.10
  'plucky',  // 25.04
]);

const MIRROR_BASE_URL = 'https://mirror.yandex.ru/mirrors/launchpad/ondrej/php/';
const SOURCES_FILE = '/etc/apt/sources.list.d/ondrej-php-yandex.sources';
const KEYRING_FILE = '/etc/apt/keyrings/ondrej-php.gpg';

/** Содержимое .sources-файла (deb822). */
function buildSourcesContent(codename: string): string {
  return [
    'Types: deb',
    `URIs: ${MIRROR_BASE_URL}`,
    `Suites: ${codename}`,
    'Components: main',
    `Signed-By: ${KEYRING_FILE}`,
    '',
  ].join('\n');
}

/**
 * Извлекает inline GPG-ключ из существующего ondrej PPA `.sources`-файла
 * (созданного `add-apt-repository ppa:ondrej/php`) и кладёт его в keyring,
 * который затем переиспользуется зеркалом.
 *
 * Возвращает true если ключ был создан/уже существовал, false — если не нашли
 * исходник для извлечения.
 */
async function ensureOndrejKeyring(ctx: MigrationContext): Promise<boolean> {
  if (await ctx.exists(KEYRING_FILE)) {
    return true;
  }

  // Ищем файл оригинального PPA (имя зависит от add-apt-repository: обычно
  // `ondrej-ubuntu-php-<codename>.sources`, но иногда `ondrej-php.list` для legacy).
  const { stdout: lsOut } = await ctx.exec.runShell(
    'ls /etc/apt/sources.list.d/ondrej-ubuntu-php-*.sources 2>/dev/null | head -1 || true',
  );
  const sourceFile = lsOut.trim();
  if (!sourceFile) {
    ctx.log(
      `WARN [ondrej-mirror]: не найден исходный .sources файл ondrej PPA — keyring не извлечён`,
    );
    return false;
  }

  try {
    // Извлекаем inline-ключ (блок Signed-By: <armored key>).
    // Каждая строка ключа — с одним ведущим пробелом, точка одна на пустой строке.
    await ctx.exec.runShell(
      `set -e; \
       mkdir -p /etc/apt/keyrings; \
       awk '/^Signed-By:/{flag=1; sub(/^Signed-By:[[:space:]]*/,""); print; next} \
            flag && /^[[:space:]]/{sub(/^[[:space:]]/,""); print; next} \
            flag{exit}' ${shellEscape(sourceFile)} \
       | sed 's/^ *\\.$//' \
       | gpg --dearmor > ${shellEscape(KEYRING_FILE)}.tmp && \
       mv ${shellEscape(KEYRING_FILE)}.tmp ${shellEscape(KEYRING_FILE)} && \
       chmod 0644 ${shellEscape(KEYRING_FILE)}`,
    );
    ctx.log(`[ondrej-mirror] keyring извлечён в ${KEYRING_FILE} из ${sourceFile}`);
    return true;
  } catch (e) {
    ctx.log(
      `WARN [ondrej-mirror]: не удалось извлечь GPG-ключ: ${(e as Error).message.slice(0, 200)}`,
    );
    return false;
  }
}

/**
 * Quick-probe зеркала Yandex для конкретного codename'а.
 * Возвращает true если InRelease отвечает 200 за ≤5с.
 */
async function probeYandexMirror(ctx: MigrationContext, codename: string): Promise<boolean> {
  try {
    const { stdout } = await ctx.exec.runShell(
      `curl -4 -sS -o /dev/null --max-time 5 -w '%{http_code}' ` +
        `${shellEscape(`${MIRROR_BASE_URL}dists/${codename}/InRelease`)} 2>/dev/null || echo 000`,
    );
    return stdout.trim() === '200';
  } catch {
    return false;
  }
}

/**
 * Главная функция: подключает зеркало Yandex как дополнительный apt-источник.
 *
 * Безопасна для повторного запуска. Не делает ничего:
 *   - на не-Ubuntu (зеркало содержит только Ubuntu codename'ы);
 *   - на codename'е, которого нет в YANDEX_SUPPORTED_CODENAMES;
 *   - если зеркало не отвечает (probe);
 *   - если файл уже существует с правильным содержимым.
 *
 * Возвращает результат для логирования вызывающим кодом.
 */
export async function ensureOndrejYandexMirror(
  ctx: MigrationContext,
  args: { distroId: string; codename: string; doAptUpdate?: boolean },
): Promise<{
  added: boolean;
  reason: string;
}> {
  const { distroId, codename, doAptUpdate = true } = args;

  if (distroId !== 'ubuntu') {
    return { added: false, reason: `skip: distro=${distroId} (зеркало Yandex — только Ubuntu)` };
  }
  if (!codename) {
    return { added: false, reason: 'skip: codename не определён' };
  }
  if (!YANDEX_SUPPORTED_CODENAMES.has(codename)) {
    return { added: false, reason: `skip: codename=${codename} не зеркалируется Yandex` };
  }

  // 1. Извлекаем GPG-ключ ondrej (если уже есть — переиспользуем).
  const haveKey = await ensureOndrejKeyring(ctx);
  if (!haveKey) {
    return {
      added: false,
      reason: 'skip: GPG keyring не доступен (исходный PPA ещё не подключён?)',
    };
  }

  // 2. Probe зеркала.
  const alive = await probeYandexMirror(ctx, codename);
  if (!alive) {
    return {
      added: false,
      reason: `skip: probe ${MIRROR_BASE_URL}dists/${codename}/InRelease не вернул 200`,
    };
  }

  // 3. Проверяем уже существующий файл — идемпотентность.
  const desiredContent = buildSourcesContent(codename);
  if (await ctx.exists(SOURCES_FILE)) {
    const existing = await ctx.readFile(SOURCES_FILE);
    if (existing.trim() === desiredContent.trim()) {
      return { added: false, reason: `OK: ${SOURCES_FILE} уже на месте, содержимое совпадает` };
    }
  }

  // 4. Записываем .sources файл.
  await ctx.writeFile(SOURCES_FILE, desiredContent, 0o644);

  // 5. Обновляем индекс ТОЛЬКО для нового источника (не валим update других репо
  // если launchpad лежит). Если doAptUpdate=false — оставляем для вызывающего кода.
  if (doAptUpdate) {
    try {
      await ctx.exec.runShell(
        `DEBIAN_FRONTEND=noninteractive apt-get update -qq ` +
          `-o Dir::Etc::sourcelist=sources.list.d/ondrej-php-yandex.sources ` +
          `-o Dir::Etc::sourceparts=- ` +
          `-o APT::Get::List-Cleanup=0 ` +
          `-o Acquire::ForceIPv4=true`,
      );
    } catch (e) {
      // Не валим: даже если update упал, файл уже на месте.
      ctx.log(`WARN [ondrej-mirror]: apt-get update упал: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  return {
    added: true,
    reason: `OK: подключено зеркало Yandex для ondrej/php (${codename})`,
  };
}

/**
 * Безопасное цитирование строки для одинарных кавычек в shell.
 * Используется внутри `runShell` сценариев.
 */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
