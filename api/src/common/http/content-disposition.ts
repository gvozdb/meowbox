/**
 * Построение заголовка `Content-Disposition: attachment` без риска
 * header-injection и с корректной поддержкой не-ASCII имён (RFC 6266).
 *
 * Что здесь важно:
 *   - Обычный `filename="..."` требует escape для `"` и `\`. Без него
 *     имя типа `file"; foo=bar.pdf` может поломать парсинг заголовка или
 *     в теории инжектить `Set-Cookie`/другие поля (newline-injection).
 *   - Для не-ASCII (кириллица, emoji) стандарт требует `filename*=UTF-8''...`
 *     с `encodeURIComponent`. Без него Safari/Chrome показывают вопросы.
 *   - Управляющие символы (`\r`, `\n`, `\0`) блокируем явно — это единственный
 *     способ по-настоящему сломать HTTP-ответ.
 *
 * Возвращает готовую строку для `res.setHeader('Content-Disposition', …)`.
 */

const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/g;

function sanitizeFilename(input: string): string {
  // Отрезаем путь — на всякий случай, если кто-то передал что-то типа "a/b.txt".
  const onlyName = input.replace(/.*[\\/]/, '') || 'download';
  // Удаляем control-chars полностью, кавычки/backslash меняем на `_`.
  return onlyName
    .replace(CONTROL_CHARS_RE, '')
    .replace(/["\\]/g, '_')
    .slice(0, 255) || 'download';
}

function asciiFallback(filename: string): string {
  // Для фаллбэка оставим только ASCII printable (0x20-0x7E минус `"` и `\`).
  let ascii = '';
  for (const ch of filename) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7e && ch !== '"' && ch !== '\\') ascii += ch;
  }
  return ascii || 'download';
}

export function attachmentDisposition(filename: string): string {
  const clean = sanitizeFilename(String(filename ?? ''));
  const ascii = asciiFallback(clean);
  const encoded = encodeURIComponent(clean);
  // Браузеры, поддерживающие filename*, игнорируют обычный filename —
  // отдаём оба для совместимости со старыми клиентами.
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
