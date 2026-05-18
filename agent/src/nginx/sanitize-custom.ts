/**
 * Санитайзер пользовательского nginx-сниппета (95-custom.conf).
 *
 * 95-custom.conf подключается include'ом ВНУТРИ server-блока. Часть директив
 * там либо невалидна по контексту, либо ссылается на shared-зону, которую
 * определяют в http-контексте. Если зоны/кэша нет — `nginx -t` падает:
 *   - `limit_req_zone`/`*_cache_path` в server-контексте → "directive is not
 *     allowed here";
 *   - `limit_req zone=foo` без `limit_req_zone` → "zero size shared memory
 *     zone \"foo\"" (зона добавлена как ссылка с size=0, реального объявления нет).
 *
 * Откуда это берётся: миграция с hostpanel тянет per-site nginx-конфиг, а
 * объявления rate-limit зон и cache-path живут в глобальном nginx.conf
 * источника и НЕ переносятся. У meowbox свой rate-limit (зона mb_<domainId>,
 * чанк 50-security.conf), поэтому чужие limit_*-директивы просто срезаем.
 *
 * Срезаем только однострочные `;`-директивы — блочные (geo/map/upstream)
 * парсер hostpanel сюда не кладёт.
 */

/** Однострочные директивы, небезопасные/невалидные в server-контексте. */
const UNSAFE_DIRECTIVES = new Set([
  // Объявления shared-зон — только http-контекст.
  'limit_req_zone',
  'limit_conn_zone',
  'proxy_cache_path',
  'fastcgi_cache_path',
  'uwsgi_cache_path',
  'scgi_cache_path',
  // Ссылки на shared-зону/кэш — зона может быть не объявлена → "zero size".
  'limit_req',
  'limit_conn',
  'proxy_cache',
  'fastcgi_cache',
  'uwsgi_cache',
  'scgi_cache',
]);

/** true → директиву нельзя слепо переносить в server-context custom-сниппет. */
export function isUnsafeCustomDirective(directive: string): boolean {
  return UNSAFE_DIRECTIVES.has(directive);
}

/** Имя директивы из строки конфига (первый токен), либо null для пустых/комментариев. */
function directiveName(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  return trimmed.match(/^([a-z_]+)\b/i)?.[1]?.toLowerCase() ?? null;
}

/**
 * Срезает из произвольного 95-custom.conf директивы, которые сломают `nginx -t`
 * в server-контексте. Срезанная строка заменяется комментарием — оператор
 * видит, что и почему удалено. Идемпотентно: повторный прогон ничего не меняет.
 */
export function sanitizeCustomNginxConfig(raw: string | null | undefined): string {
  if (!raw) return raw ?? '';
  return raw
    .split('\n')
    .map((line) => {
      const directive = directiveName(line);
      if (directive && isUnsafeCustomDirective(directive)) {
        return `# [meowbox] срезана директива (невалидна/нет зоны в server-контексте): ${line.trim()}`;
      }
      return line;
    })
    .join('\n');
}
