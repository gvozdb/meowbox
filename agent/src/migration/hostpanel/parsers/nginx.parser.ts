/**
 * Парсер старых nginx-конфигов hostPanel (живут в /var/www/<user>/{access,domains,main}.nginx).
 * Не полноценный AST, а pragmatic-парсер: извлекает то, что нам нужно для
 * генерации нашего layered-конфига:
 *   - server_name + main_host (→ Site.domain + Site.aliases)
 *   - bot-блок (если есть `if ($http_user_agent ~* (Bots...)) return 444`)
 *   - location-блоки adminka/connectors_xxx (имена директорий MODX)
 *   - неопознанные snippet'ы → копируем в Site.nginxCustomConfig (95-custom.conf)
 *
 * Подход: токенизация (комментарии → удалить; пробелы → нормализовать), затем
 * простая state-машина для server { ... } блоков.
 */

export interface ParsedNginx {
  /** Главный домен (server_name первый). */
  mainDomain: string | null;
  /** Алиасы (остальные server_name; `if ($host != $main_host) return 301` интерпретируем). */
  aliases: string[];
  /**
   * Источник содержит правило вида `if ($host != $main_host) return 301 ...` —
   * значит все алиасы должны 301-редиректить на главный домен. Если флаг
   * выставлен — мы создаём alias-записи с `redirect=true` (см. spec §7.2).
   */
  aliasesRedirectToMain: boolean;
  /** Имена директорий manager/connectors (из location ~* ^/(adminka|connectors_xxx|...)). */
  managerDir: string | null;
  connectorsDir: string | null;
  /**
   * Сырое значение nginx `root ...;` директивы (обычно `/var/www/<u>/www`).
   * Используется для определения `filesRelPath` (см. discover.ts).
   */
  root: string | null;
  /** Кастомные директивы, которые мы не распознали — пойдут в 95-custom.conf */
  unknownSnippet: string;
  /** HSTS присутствует. */
  hsts: boolean;
  /** Было ли `add_header Content-Security-Policy` — переносим в custom. */
  csp: string | null;
  /** Был ли bot-блок (return 444). */
  botBlock: boolean;
  /**
   * MODX SEO-friendly URLs включены: блок
   * `error_page 404 = @modx; location @modx { rewrite ^/(.*)$ /index.php?q=$1&$args last; }`
   * (или экв. через `try_files ... @rewrite`). Spec §7.2.
   */
  modxFriendlyUrls: boolean;
}

const KNOWN_DIRECTIVES = new Set([
  'listen', 'root', 'index', 'access_log', 'error_log',
  'rewrite_log', 'charset', 'set', 'include', 'server_name',
  'ssl_certificate', 'ssl_certificate_key', 'ssl_trusted_certificate',
  'try_files', 'rewrite', 'return', 'fastcgi_pass', 'fastcgi_param',
  'location', 'if', 'add_header', 'expires', 'proxy_pass',
]);

function stripComments(raw: string): string {
  return raw
    .split('\n')
    .map((l) => {
      const i = l.indexOf('#');
      return i === -1 ? l : l.slice(0, i);
    })
    .join('\n');
}

function extractServerNames(raw: string): string[] {
  const out: string[] = [];
  const re = /server_name\s+([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (!m[1]) continue;
    const names = m[1].split(/\s+/).filter(Boolean);
    out.push(...names);
  }
  return out;
}

function extractMainHost(raw: string): string | null {
  // Часто конструкция: `set $main_host 'allgifts.kz';`
  const m = raw.match(/set\s+\$main_host\s+['"]([^'"]+)['"]/);
  return m?.[1] || null;
}

/**
 * Достаёт первое значение `root <path>;` (вне комментариев). hostPanel
 * обычно пишет один root на сервер, иногда несколько в разных server-блоках —
 * берём первый «непустой» (а не /var/www/html).
 */
function extractRoot(raw: string): string | null {
  const re = /^\s*root\s+([^;]+);/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const v = (m[1] || '').trim().replace(/^['"]|['"]$/g, '');
    if (!v) continue;
    if (v === '/var/www/html' || v === '/usr/share/nginx/html') continue;
    return v;
  }
  return null;
}

function extractModxDirs(raw: string): { managerDir: string | null; connectorsDir: string | null } {
  // Шаблон hostPanel: location ~* ^/(adminka|connectors_xxx|connectors-xxx|admin|manager|...)/ { ... }
  // Берём список и ищем что-то с префиксом connectors / managers / adminka / admin.
  let managerDir: string | null = null;
  let connectorsDir: string | null = null;
  const re = /location\s+~\*?\s+\^\/\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (!m[1]) continue;
    const items = m[1].split('|').map((s) => s.trim()).filter(Boolean);
    for (const it of items) {
      const lower = it.toLowerCase();
      if (
        !connectorsDir &&
        (lower === 'connectors' || lower.startsWith('connectors_') || lower.startsWith('connectors-') || lower.startsWith('cnnctrs'))
      ) {
        connectorsDir = it;
      }
      if (
        !managerDir &&
        (lower === 'manager' || lower === 'adminka' || lower === 'admin' || lower === 'mngr' || lower === 'm')
      ) {
        managerDir = it;
      }
    }
  }
  return { managerDir, connectorsDir };
}

function extractCsp(raw: string): string | null {
  const m = raw.match(/add_header\s+Content-Security-Policy\s+["']([^"']+)["']/);
  return m?.[1] || null;
}

function hasHsts(raw: string): boolean {
  return /Strict-Transport-Security/i.test(raw);
}

function hasBotBlock(raw: string): boolean {
  return /http_user_agent[\s\S]+?return\s+444/.test(raw);
}

/**
 * Определяет наличие конструкции `if ($host != $main_host) return 301 ...;`
 * (или эквивалент с `!~` и URI-template'ом). Это маркер того, что все
 * non-main алиасы редиректят на главный домен.
 */
/**
 * MODX 2.x SEO-friendly URLs: hostpanel-генератор обычно создаёт
 *   error_page 404 = @modx;
 *   location @modx { rewrite ^/(.*)$ /index.php?q=$1&$args last; }
 * либо через `try_files $uri $uri/ @rewrite; location @rewrite { rewrite ... }`.
 */
function hasModxFriendlyUrls(raw: string): boolean {
  if (/error_page\s+404\s*=\s*@modx/.test(raw)) return true;
  if (/location\s+@(modx|rewrite)\s*\{[\s\S]*?rewrite\s+\^\/\(.*\)\$\s+\/index\.php\?q=\$1/.test(raw)) {
    return true;
  }
  return false;
}

function hasAliasRedirectToMain(raw: string): boolean {
  // Варианты: `if ($host != $main_host) { return 301 ... }`,
  //           `if ($host !~* "^main_host$") return 301 ...;`,
  //           `if ($host != "main.tld") return 301 https://main.tld$request_uri;`
  return /if\s*\(\s*\$host\s*(?:!=|!~\*?)\s*[^)]+\)\s*\{?\s*return\s+30[12]/i.test(raw);
}

/**
 * Собирает unknownSnippet — все строки, что не относятся к стандартным
 * шаблонам hostPanel и нашему layered-формату. Простой rule-of-thumb: берём
 * любые `if (...) {`, `add_header ...` (кроме HSTS/CSP, которые мы маппим),
 * `proxy_pass`, и пр., кроме самых базовых (root/index/listen/server_name/include/access_log...).
 *
 * Возвращает многострочный фрагмент с комментарием-пояснением.
 */
function extractUnknownSnippet(raw: string, modxFriendlyUrls: boolean): string {
  const lines = raw.split('\n');
  const result: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;
    // Берём только директивы (есть `;` или `{`).
    if (!line.match(/[;{}]\s*$/)) continue;

    // Голый `break;` — артефакт MODX-rewrite-блока вне контекста, мусор.
    if (line === 'break;') continue;

    // MODX SEO-friendly URLs мы рендерим сами в layered-конфиге через флаг
    // `modxFriendlyUrls` (см. nginx-template). Не дублируем error_page и
    // location @modx — иначе в custom-снippet падают орфаны вида
    // `error_page 404 = @modx;` без сопровождающего location.
    if (modxFriendlyUrls && /^error_page\s+404\s*=\s*@(modx|rewrite)\s*;?$/i.test(line)) continue;

    // Парсим имя директивы
    const directive = line.match(/^(\w+)/)?.[1];
    if (!directive) continue;
    if (KNOWN_DIRECTIVES.has(directive)) continue;
    // location/if/server мы тоже хотим пропустить как стандартные (их обработка
    // ниже + аналог в нашем layered):
    if (directive === 'location' || directive === 'if' || directive === 'server' || directive === 'upstream') continue;
    result.push(line);
  }
  if (result.length === 0) return '';
  return [
    '# === Imported from hostpanel (автоперенос, проверь!) ===',
    ...result,
    '# === end imported ===',
  ].join('\n');
}

/**
 * Главный парсер. На вход — конкатенация {access,domains,main}.nginx.
 */
export function parseHostpanelNginx(rawCombined: string): ParsedNginx {
  const raw = stripComments(rawCombined);

  const serverNames = extractServerNames(raw);
  const mainHost = extractMainHost(raw);

  let mainDomain: string | null = null;
  const aliases: string[] = [];
  if (mainHost) {
    mainDomain = mainHost;
    for (const n of serverNames) if (n !== mainHost) aliases.push(n);
  } else if (serverNames.length > 0) {
    mainDomain = serverNames[0]!;
    aliases.push(...serverNames.slice(1));
  }

  const { managerDir, connectorsDir } = extractModxDirs(raw);
  const csp = extractCsp(raw);
  const hsts = hasHsts(raw);
  const botBlock = hasBotBlock(raw);
  const aliasesRedirectToMain = hasAliasRedirectToMain(raw);
  const modxFriendlyUrls = hasModxFriendlyUrls(raw);
  const unknownSnippet = extractUnknownSnippet(raw, modxFriendlyUrls);
  const root = extractRoot(raw);

  return {
    mainDomain,
    aliases: Array.from(new Set(aliases)),
    aliasesRedirectToMain,
    managerDir,
    connectorsDir,
    root,
    unknownSnippet,
    hsts,
    csp,
    botBlock,
    modxFriendlyUrls,
  };
}
