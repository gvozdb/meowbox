/**
 * Применяет palette-класс на <html> как можно раньше — ещё до рендера layout'а.
 * Без этого первая отрисовка страницы (login, прелоадер) будет с дефолтной
 * amber-палитрой, а уже потом мигнёт в нужную (если у юзера выбрана violet).
 *
 * Логика: читаем выбранный сервер из localStorage (`meowbox-server`,
 * fallback 'main') → читаем его cached палитру (`meowbox-palette-{id}`) →
 * вешаем класс. Если в cache ничего нет — оставляем `palette-amber` дефолтом.
 */

import { PALETTE_OPTIONS, type PaletteId } from '../composables/usePalette';

export default defineNuxtPlugin(() => {
  if (typeof document === 'undefined' || typeof localStorage === 'undefined') return;

  const serverId = localStorage.getItem('meowbox-server') || 'main';
  const raw = localStorage.getItem(`meowbox-palette-${serverId}`);
  const isValid = (v: unknown): v is PaletteId => PALETTE_OPTIONS.some((p) => p.id === v);
  const palette: PaletteId = isValid(raw) ? raw : 'amber';

  const html = document.documentElement;
  for (const opt of PALETTE_OPTIONS) {
    html.classList.toggle(`palette-${opt.id}`, opt.id === palette);
  }
});
