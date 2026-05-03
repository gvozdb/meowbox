/**
 * Palette (цветовая гамма) — отдельный слой поверх light/dark темы.
 * Палитра задаёт primary-related переменные (--primary*, --focus-ring,
 * --shadow-button*, --shadow-login). Класс <html class="palette-{name}">.
 *
 * Хранение: per-server, ВСЕ палитры лежат на мастере одной записью
 * (`appearance.palettes: { [serverId]: PaletteId }`). Slave не участвует —
 * фича работает даже когда на slave старая версия панели без endpoint'а
 * /panel-settings/appearance.
 *
 * Кеш в localStorage `meowbox-palette-{serverId}` нужен только для мгновенного
 * применения класса при смене сервера в сайдбаре (до того, как страница
 * перезагрузит данные с API).
 */

export const PALETTE_OPTIONS = [
  { id: 'amber',    label: 'Янтарь',  swatch: '#f59e0b', description: 'Тёплая янтарная гамма (по умолчанию)' },
  { id: 'violet',   label: 'Аметист', swatch: '#8b5cf6', description: 'Холодная фиолетовая гамма' },
  { id: 'emerald',  label: 'Изумруд', swatch: '#10b981', description: 'Свежая изумрудно-зелёная гамма' },
  { id: 'sapphire', label: 'Сапфир',  swatch: '#3b82f6', description: 'Глубокая сапфирово-синяя гамма' },
  { id: 'rose',     label: 'Роза',    swatch: '#f43f5e', description: 'Насыщенная розово-малиновая гамма' },
  { id: 'teal',     label: 'Бирюза',  swatch: '#14b8a6', description: 'Морская бирюзово-циан гамма' },
  { id: 'fuchsia',  label: 'Фуксия',  swatch: '#d946ef', description: 'Яркая фуксийно-пурпурная гамма' },
] as const;

export type PaletteId = (typeof PALETTE_OPTIONS)[number]['id'];

/** Lookup: id → swatch hex (для UI без зависимости от полного объекта). */
export const PALETTE_SWATCHES: Record<PaletteId, string> = PALETTE_OPTIONS.reduce(
  (acc, p) => { acc[p.id] = p.swatch; return acc; },
  {} as Record<PaletteId, string>,
);

const DEFAULT_PALETTE: PaletteId = 'amber';
const KEY_PREFIX = 'meowbox-palette-';

const currentPalette = ref<PaletteId>(DEFAULT_PALETTE);

function isValidPalette(v: unknown): v is PaletteId {
  return PALETTE_OPTIONS.some((p) => p.id === v);
}

function cacheKey(serverId: string): string {
  return `${KEY_PREFIX}${serverId}`;
}

function readCache(serverId: string): PaletteId | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(cacheKey(serverId));
  return isValidPalette(raw) ? raw : null;
}

function writeCache(serverId: string, palette: PaletteId): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(cacheKey(serverId), palette);
}

function applyClass(palette: PaletteId, withTransition: boolean): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  if (withTransition) {
    html.classList.add('theme-transitioning');
    setTimeout(() => html.classList.remove('theme-transitioning'), 350);
  }
  // Снять предыдущий palette-* класс и навесить новый.
  for (const opt of PALETTE_OPTIONS) {
    html.classList.toggle(`palette-${opt.id}`, opt.id === palette);
  }
}

interface MinimalApi {
  get: <T>(endpoint: string, opts?: { noProxy?: boolean }) => Promise<T>;
  put: <T>(endpoint: string, body?: unknown, opts?: { noProxy?: boolean }) => Promise<T>;
}

/** Все валидные ID палитр в одной строке через '|' — для inline-скрипта в <head>. */
export const PALETTE_IDS_LIST: readonly PaletteId[] = PALETTE_OPTIONS.map((p) => p.id) as readonly PaletteId[];

export function usePalette() {
  /**
   * Применяет палитру для указанного сервера. Использует cache в localStorage
   * для мгновенного применения. Если cache пустой — дефолт (amber).
   * Параметр withTransition=false на init (избегаем мигания).
   */
  function applyForServer(serverId: string, withTransition = true): PaletteId {
    const palette = readCache(serverId) ?? DEFAULT_PALETTE;
    currentPalette.value = palette;
    applyClass(palette, withTransition);
    return palette;
  }

  /**
   * Сохраняет палитру для сервера в cache и применяет её. Используется
   * после успешного PUT /panel-settings/appearance или при синхронизации с API.
   */
  function setForServer(serverId: string, palette: PaletteId, withTransition = true): void {
    writeCache(serverId, palette);
    currentPalette.value = palette;
    applyClass(palette, withTransition);
  }

  /**
   * Только обновить cache, не применяя (если сервер не активен сейчас).
   */
  function updateCache(serverId: string, palette: PaletteId): void {
    writeCache(serverId, palette);
  }

  /** Прочитать cache (без применения). Полезно для UI «текущее значение». */
  function readForServer(serverId: string): PaletteId | null {
    return readCache(serverId);
  }

  /**
   * Подтянуть карту палитр всех серверов с мастер-API и засинхронизировать cache.
   * Бьём ВСЕГДА в мастер (noProxy=true), даже если активный сервер — slave.
   * Возвращает карту { serverId → palette } (валидные значения только).
   */
  async function loadAllFromApi(api: MinimalApi): Promise<Record<string, PaletteId>> {
    try {
      const data = await api.get<{ palettes: Record<string, PaletteId> }>(
        '/panel-settings/appearance',
        { noProxy: true },
      );
      const map = data?.palettes ?? {};
      for (const [sid, p] of Object.entries(map)) {
        if (isValidPalette(p)) writeCache(sid, p);
      }
      return map;
    } catch {
      return {};
    }
  }

  /**
   * Сохранить палитру одного сервера на мастере. Возвращает свежую карту
   * палитр (с уже применённым изменением), либо null если запрос упал.
   */
  async function saveToApi(
    api: MinimalApi,
    serverId: string,
    palette: PaletteId,
  ): Promise<Record<string, PaletteId> | null> {
    try {
      const data = await api.put<{ palettes: Record<string, PaletteId> }>(
        '/panel-settings/appearance',
        { serverId, palette },
        { noProxy: true },
      );
      // Обновим cache по факту ответа сервера, чтобы не разъехаться.
      const map = data?.palettes ?? {};
      for (const [sid, p] of Object.entries(map)) {
        if (isValidPalette(p)) writeCache(sid, p);
      }
      return map;
    } catch {
      return null;
    }
  }

  return {
    currentPalette,
    applyForServer,
    setForServer,
    updateCache,
    readForServer,
    loadAllFromApi,
    saveToApi,
    options: PALETTE_OPTIONS,
    DEFAULT_PALETTE,
  };
}
