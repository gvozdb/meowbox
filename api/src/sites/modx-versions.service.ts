import { Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_MODX_REVO_VERSION,
  DEFAULT_MODX_3_VERSION,
} from '@meowbox/shared';

/**
 * Получает актуальный список релизов MODX из GitHub API.
 * Результат кешируется в памяти на TTL (по-умолчанию 1 час) — чтобы:
 *  (а) не ходить на github на каждом запросе страницы "Новый сайт" / "Апгрейд",
 *  (б) не словить rate-limit anonymous GitHub API (60 req/ip в час).
 *
 * Отдаём две отдельных подборки (revo = 2.x, modx3 = 3.x) уже с лейблами
 * под UI — чтобы фронт ничего не собирал сам.
 *
 * Fallback-поведение:
 *   - если GitHub не ответил / вернул ерунду → возвращаем хардкод-минимум
 *     с latest-дефолтами из shared/constants, чтобы UI никогда не видел
 *     пустой список и не ломался.
 */

export interface ModxVersionEntry {
  value: string;       // "3.1.2-pl"
  label: string;       // "MODX 3.1.2 (latest)"
  isLatest: boolean;   // самая свежая в major
}

export interface ModxVersionsResult {
  revo: ModxVersionEntry[];
  modx3: ModxVersionEntry[];
  fetchedAt: string;   // ISO, для дебага в UI
  source: 'github' | 'fallback';
}

interface GithubTag {
  name: string;
}

const CACHE_TTL_MS = Number(process.env.MODX_VERSIONS_CACHE_TTL_MS) || 3600_000;
const FETCH_TIMEOUT_MS = Number(process.env.MODX_VERSIONS_FETCH_TIMEOUT_MS) || 5000;
// ВАЖНО: modxcms/revolution НЕ использует GitHub Releases (эндпоинт /releases
// отдаёт пустой массив). Все версии лежат как git-tags. Поэтому ходим в /tags.
// URL оставлен конфигурируемым (зеркало / корпоративный Gitea / тестовый endpoint).
const GITHUB_API_URL =
  process.env.MODX_TAGS_URL ||
  'https://api.github.com/repos/modxcms/revolution/tags?per_page=100';
// Опциональный token для GitHub API — снимает лимит 60 req/hour на анонимов.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
// Сколько минорных версий в каждом major отдаём в UI. Больше — мусор в dropdown;
// меньше — пользователю, которому нужен даунгрейд на старое, не хватит выбора.
const MAX_ENTRIES_PER_MAJOR = 10;

@Injectable()
export class ModxVersionsService {
  private readonly logger = new Logger('ModxVersionsService');
  private cache: { at: number; data: ModxVersionsResult } | null = null;
  // Одновременно идущий запрос — все конкурентные вызовы получают один и тот же
  // результат, чтобы не бомбить github одинаковыми запросами при первом заходе.
  private inflight: Promise<ModxVersionsResult> | null = null;

  async getVersions(forceRefresh = false): Promise<ModxVersionsResult> {
    if (!forceRefresh && this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) {
      return this.cache.data;
    }
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      try {
        const data = await this.fetchFromGithub();
        this.cache = { at: Date.now(), data };
        return data;
      } catch (err) {
        this.logger.warn(`GitHub MODX releases fetch failed: ${(err as Error).message}`);
        // Если кеш есть (даже просроченный) — лучше вернуть его, чем fallback.
        if (this.cache) return this.cache.data;
        const fallback = this.buildFallback();
        this.cache = { at: Date.now(), data: fallback };
        return fallback;
      } finally {
        this.inflight = null;
      }
    })();

    return this.inflight;
  }

  private async fetchFromGithub(): Promise<ModxVersionsResult> {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let resp: Response;
    try {
      const headers: Record<string, string> = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'meowbox-panel',
      };
      if (GITHUB_TOKEN) {
        headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
      }
      resp = await fetch(GITHUB_API_URL, {
        headers,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(tid);
    }
    if (!resp.ok) {
      throw new Error(`GitHub API returned ${resp.status}`);
    }
    const raw = (await resp.json()) as GithubTag[];
    if (!Array.isArray(raw)) throw new Error('GitHub returned non-array');

    // MODX тегает релизы как "v2.8.8-pl" или "v3.1.2-pl". Бывают и "3.0.0-rc3",
    // "-beta2", "-alpha3" — в UI показываем только стабильные (-pl), остальное
    // отсекаем здесь.
    const TAG_RE = /^v?([0-9]+)\.([0-9]+)\.([0-9]+)(-pl)$/;
    type Parsed = { value: string; major: number; minor: number; patch: number };
    const parsed: Parsed[] = [];
    for (const r of raw) {
      const tag = (r.name || '').trim();
      const m = TAG_RE.exec(tag);
      if (!m) continue;
      const major = Number(m[1]);
      const minor = Number(m[2]);
      const patch = Number(m[3]);
      if (major !== 2 && major !== 3) continue;
      parsed.push({
        value: `${major}.${minor}.${patch}-pl`,
        major,
        minor,
        patch,
      });
    }

    // Сортируем от новой к старой внутри каждого major.
    parsed.sort((a, b) => {
      if (a.major !== b.major) return b.major - a.major;
      if (a.minor !== b.minor) return b.minor - a.minor;
      return b.patch - a.patch;
    });

    const revo = this.toEntries(parsed.filter((p) => p.major === 2), 'MODX Revolution');
    const modx3 = this.toEntries(parsed.filter((p) => p.major === 3), 'MODX');

    // Если по какой-то причине ни одного релиза не пропарсилось (GitHub изменил
    // формат, все релизы оказались prerelease) — берём fallback, чтобы UI не был пустой.
    if (revo.length === 0 && modx3.length === 0) {
      throw new Error('No stable MODX releases parsed from GitHub response');
    }
    if (revo.length === 0) revo.push(...this.buildFallback().revo);
    if (modx3.length === 0) modx3.push(...this.buildFallback().modx3);

    return {
      revo,
      modx3,
      fetchedAt: new Date().toISOString(),
      source: 'github',
    };
  }

  private toEntries(
    parsed: Array<{ value: string; major: number; minor: number; patch: number }>,
    labelPrefix: string,
  ): ModxVersionEntry[] {
    return parsed.slice(0, MAX_ENTRIES_PER_MAJOR).map((p, idx) => ({
      value: p.value,
      label:
        idx === 0
          ? `${labelPrefix} ${p.major}.${p.minor}.${p.patch} (latest)`
          : `${labelPrefix} ${p.major}.${p.minor}.${p.patch}`,
      isLatest: idx === 0,
    }));
  }

  private buildFallback(): ModxVersionsResult {
    return {
      revo: [
        { value: DEFAULT_MODX_REVO_VERSION, label: `MODX Revolution ${DEFAULT_MODX_REVO_VERSION.replace('-pl', '')} (latest)`, isLatest: true },
      ],
      modx3: [
        { value: DEFAULT_MODX_3_VERSION, label: `MODX ${DEFAULT_MODX_3_VERSION.replace('-pl', '')} (latest)`, isLatest: true },
      ],
      fetchedAt: new Date().toISOString(),
      source: 'fallback',
    };
  }
}
