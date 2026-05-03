/**
 * Panel-update — серверная часть страницы /admin/updates.
 *
 * Запускает `tools/update.sh` через spawn, парсит stdout (`[stage:NAME] ...`),
 * обновляет `PanelUpdateState` в БД (поле `currentStage` + tail логов).
 * UI делает polling `/api/admin/update/status` раз в 1 сек.
 *
 * Advisory lock: один запуск за раз. Хранится в `PanelUpdateState.pid` —
 * перед стартом проверяем что pid либо отсутствует, либо процесс мёртв.
 *
 * История: после завершения update.sh пишется запись в `PanelUpdateHistory`.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../common/prisma.service';

const STAGE_ORDER = [
  'preflight',
  'snapshot',
  'download',
  'verify',
  'extract',
  'install',
  'migrate',
  'switch',
  'reload',
  'healthcheck',
  'cleanup',
] as const;

export type UpdateStage = typeof STAGE_ORDER[number];

export interface UpdateStatusResponse {
  current: string;
  latest: string | null;
  latestCheckedAt: string | null;
  state: {
    status: 'idle' | 'running' | 'succeeded' | 'failed' | 'rolled_back';
    fromVersion: string | null;
    toVersion: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    pid: number | null;
    currentStage: string | null;
    errorMessage: string | null;
    logTail: string;
  };
  stages: typeof STAGE_ORDER;
  history: Array<{
    id: string;
    fromVersion: string | null;
    toVersion: string;
    status: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    triggeredBy: string | null;
    errorMessage: string | null;
  }>;
}

@Injectable()
export class PanelUpdateService implements OnModuleInit {
  private readonly logger = new Logger(PanelUpdateService.name);
  private latestCache: { tag: string | null; checkedAt: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * При старте API: если в БД висит status=running с живым pid — это значит
   * мы только что рестартанулись посередине апдейта (pm2 reload во время
   * стадии reload). Подцепляем watcher на лог-файл, чтобы продолжить
   * обновлять state и финализировать запись в History.
   */
  async onModuleInit(): Promise<void> {
    try {
      const state = await this.prisma.panelUpdateState.findUnique({ where: { id: 'current' } });
      if (!state || state.status !== 'running' || !state.pid) return;
      if (!this.isProcessAlive(state.pid)) {
        // Процесс уже мёртв — финализируем сразу. Успех определяем
        // по наличию sentinel-файла state/.update-success (его пишет
        // update.sh строкой после "Update OK"). Это надёжнее regex по
        // логу, потому что лог может быть обрывистый (pm2 reload race).
        const panelDir = this.getPanelDir();
        const stateDir = process.env.MEOWBOX_STATE_DIR || path.join(panelDir, 'state');
        const logFilePath = path.join(stateDir, 'logs', 'panel-update.log');
        const sentinelPath = path.join(stateDir, '.update-success');
        let logTail = '';
        try { logTail = await fsp.readFile(logFilePath, 'utf8'); } catch { /* */ }
        const okBySentinel = await this.fileExists(sentinelPath);
        const okByLog = /\[update\] ✓ Update OK:/.test(logTail);
        const ok = okBySentinel || okByLog;
        await this.prisma.panelUpdateState.update({
          where: { id: 'current' },
          data: {
            status: ok ? 'succeeded' : 'failed',
            finishedAt: new Date(),
            errorMessage: ok ? null : this.extractErrorFromLog(logTail) || 'update.sh died',
            logTail: logTail.slice(-16 * 1024),
          },
        });
        if (ok) {
          await fsp.unlink(sentinelPath).catch(() => {});
        }
        this.logger.log(`Resumed update state: ${ok ? 'succeeded' : 'failed'} (pid was dead, sentinel=${okBySentinel})`);
        return;
      }
      // Pid жив — переподцепляем watcher.
      this.logger.log(`Resuming watcher for live update (pid=${state.pid})`);
      const panelDir = this.getPanelDir();
      const stateDir = process.env.MEOWBOX_STATE_DIR || path.join(panelDir, 'state');
      const logFilePath = path.join(stateDir, 'logs', 'panel-update.log');
      this.attachLogWatcher(
        logFilePath,
        state.fromVersion ?? 'unknown',
        state.toVersion ?? 'unknown',
        state.pid ? `resumed:pid=${state.pid}` : 'resumed',
        state.pid,
      );
    } catch (e) {
      this.logger.warn(`onModuleInit: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // STATUS
  // ---------------------------------------------------------------------------

  /**
   * Лёгкий summary для сайдбара: текущая + latest + флаг hasUpdate.
   * latest кешируется (см. `latestCache`); refreshLatest=true форсит GitHub-запрос.
   */
  async getVersionSummary(refreshLatest = false): Promise<{
    current: string;
    latest: string | null;
    hasUpdate: boolean;
    checkedAt: string | null;
  }> {
    const current = this.readCurrentVersion();
    const latest = refreshLatest ? await this.fetchLatestTag() : (this.latestCache?.tag ?? null);
    const hasUpdate = !!(latest && current && current !== 'unknown' && latest !== current);
    const checkedAt = this.latestCache?.checkedAt ? new Date(this.latestCache.checkedAt).toISOString() : null;
    return { current, latest, hasUpdate, checkedAt };
  }

  async getStatus(refreshLatest = false): Promise<UpdateStatusResponse> {
    const current = this.readCurrentVersion();
    const latest = refreshLatest ? await this.fetchLatestTag() : (this.latestCache?.tag ?? null);

    let state = await this.prisma.panelUpdateState.findUnique({ where: { id: 'current' } });
    if (!state) {
      state = await this.prisma.panelUpdateState.create({
        data: { id: 'current', status: 'idle' },
      });
    }

    // Если status=running, но pid мёртв — корректируем итог.
    //
    // КРИТИЧНО: проверяем sentinel-файл (`state/.update-success`) ДО того,
    // как помечать failed. update.sh пишет его перед exit'ом, и эта проверка
    // должна быть консистентна с onModuleInit и tick() в watcher'е — иначе
    // race: успешный апдейт между моментом смерти pid'а и следующим тиком
    // watcher'а (1.5с) frontend опрашивает getStatus, видит dead pid и
    // мочит state как failed, хотя апдейт фактически прошёл.
    //
    // Дополнительно: даём watcher'у 3-секундный grace-period — если pid
    // только что умер, watcher вот-вот сам финализирует через флаш в БД.
    // Не мутируем state в чтении-эндпоинте, чтобы не конкурировать с ним.
    if (state.status === 'running' && state.pid && !this.isProcessAlive(state.pid)) {
      const panelDir = this.getPanelDir();
      const stateDir = process.env.MEOWBOX_STATE_DIR || path.join(panelDir, 'state');
      const sentinelPath = path.join(stateDir, '.update-success');
      const logFilePath = path.join(stateDir, 'logs', 'panel-update.log');

      const okBySentinel = fs.existsSync(sentinelPath);
      let okByLog = false;
      let logTail = '';
      try { logTail = await fsp.readFile(logFilePath, 'utf8'); } catch { /* */ }
      okByLog = /\[update\] ✓ Update OK:/.test(logTail);
      const ok = okBySentinel || okByLog;

      // Если есть финальный сигнал (sentinel/log) — финализируем как
      // succeeded. Если нет — даём watcher'у дотикать; сам не мутируем
      // (watcher разгребёт и поставит failed, или onModuleInit подхватит).
      if (ok) {
        state = await this.prisma.panelUpdateState.update({
          where: { id: 'current' },
          data: {
            status: 'succeeded',
            errorMessage: null,
            finishedAt: new Date(),
            logTail: logTail.slice(-16 * 1024),
          },
        });
        await fsp.unlink(sentinelPath).catch(() => {});
      } else {
        // Grace-period: pid умер только что, watcher ещё не финализировал.
        // Если с finishedAt прошло >5с с момента старта, и финального
        // признака нет — фиксируем failed.
        const startedAt = state.startedAt?.getTime() ?? Date.now();
        const ageMs = Date.now() - startedAt;
        if (ageMs > 5_000) {
          state = await this.prisma.panelUpdateState.update({
            where: { id: 'current' },
            data: {
              status: 'failed',
              errorMessage: this.extractErrorFromLog(logTail) || 'update.sh died unexpectedly (pid not found)',
              finishedAt: new Date(),
              logTail: logTail.slice(-16 * 1024),
            },
          });
        }
        // если age < 5с — оставляем status=running, watcher дотикает
      }
    }

    const history = await this.prisma.panelUpdateHistory.findMany({
      orderBy: { startedAt: 'desc' },
      take: 10,
    });

    return {
      current,
      latest,
      latestCheckedAt: this.latestCache ? new Date(this.latestCache.checkedAt).toISOString() : null,
      state: {
        status: state.status as UpdateStatusResponse['state']['status'],
        fromVersion: state.fromVersion,
        toVersion: state.toVersion,
        startedAt: state.startedAt ? state.startedAt.toISOString() : null,
        finishedAt: state.finishedAt ? state.finishedAt.toISOString() : null,
        pid: state.pid,
        currentStage: state.currentStage,
        errorMessage: state.errorMessage,
        logTail: state.logTail ?? '',
      },
      stages: STAGE_ORDER,
      history: history.map((h) => ({
        id: h.id,
        fromVersion: h.fromVersion,
        toVersion: h.toVersion,
        status: h.status,
        startedAt: h.startedAt.toISOString(),
        finishedAt: h.finishedAt.toISOString(),
        durationMs: h.durationMs,
        triggeredBy: h.triggeredBy,
        errorMessage: h.errorMessage,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // TRIGGER
  // ---------------------------------------------------------------------------

  /**
   * Запускает обновление в фоне. Возвращает сразу после spawn — клиент
   * polling-ит `/status` чтобы видеть прогресс.
   */
  async triggerUpdate(targetVersion: string | null, userId: string, role: string): Promise<{ ok: true; pid: number }> {
    if (role !== 'ADMIN') {
      throw new ForbiddenException('Only ADMIN can trigger panel updates');
    }

    const state = await this.prisma.panelUpdateState.findUnique({ where: { id: 'current' } });
    if (state && state.status === 'running' && state.pid && this.isProcessAlive(state.pid)) {
      throw new BadRequestException(
        `Уже идёт обновление (pid=${state.pid}, stage=${state.currentStage}). Подожди завершения.`,
      );
    }

    const panelDir = this.getPanelDir();
    const updateScript = path.join(panelDir, 'tools', 'update.sh');
    if (!fs.existsSync(updateScript)) {
      throw new InternalServerErrorException(`tools/update.sh не найден по пути ${updateScript}`);
    }

    const fromVersion = this.readCurrentVersion();
    const toVersion = targetVersion || (await this.fetchLatestTag()) || 'latest';

    // Очищаем state перед стартом.
    await this.prisma.panelUpdateState.upsert({
      where: { id: 'current' },
      create: {
        id: 'current',
        status: 'running',
        fromVersion,
        toVersion,
        startedAt: new Date(),
        finishedAt: null,
        pid: null,
        currentStage: 'preflight',
        errorMessage: null,
        logTail: '',
      },
      update: {
        status: 'running',
        fromVersion,
        toVersion,
        startedAt: new Date(),
        finishedAt: null,
        pid: null,
        currentStage: 'preflight',
        errorMessage: null,
        logTail: '',
      },
    });

    // Логи update.sh пишем в файл (НЕ в pipe), потому что update.sh сам делает
    // pm2 reload meowbox-api → текущий API-процесс умирает → pipe рвётся → SIGPIPE
    // убивает update.sh посередине стадии reload. Файл переживает reload.
    // Новый API-инстанс после рестарта читает state из БД и tail-ит лог-файл.
    const stateDir = process.env.MEOWBOX_STATE_DIR || path.join(panelDir, 'state');
    const logsDir = path.join(stateDir, 'logs');
    await fsp.mkdir(logsDir, { recursive: true }).catch(() => {});
    const logFilePath = path.join(logsDir, 'panel-update.log');
    // Очищаем предыдущий лог: один лог = один update.
    await fsp.writeFile(logFilePath, '', 'utf8').catch(() => {});
    // И sentinel-файл от прошлого успешного апдейта — чтобы новый запуск
    // не финализировался ложным "succeeded" из-за старого .update-success.
    await fsp.unlink(path.join(stateDir, '.update-success')).catch(() => {});

    await this.prisma.panelUpdateState.update({
      where: { id: 'current' },
      data: { logTail: '' },
    });

    const logFd = fs.openSync(logFilePath, 'a');

    const args: string[] = [updateScript];
    if (targetVersion) args.push(targetVersion);
    args.push(`--triggered-by=user:${userId}`);

    const child = spawn('bash', args, {
      cwd: panelDir,
      env: {
        ...process.env,
        MEOWBOX_TRIGGERED_BY: `user:${userId}`,
        MEOWBOX_UPDATE_LOG: logFilePath,
      },
      // КРИТИЧНО: stdin=ignore, stdout/stderr → файл (не pipe).
      // Когда API рестартанётся в стадии reload, child уже отвязан от pipes
      // и продолжит писать в файл. Без этого — SIGPIPE → exit посередине.
      stdio: ['ignore', logFd, logFd],
      detached: true,
    });

    // fd закрываем в parent — child сохранил свою копию.
    fs.closeSync(logFd);

    if (!child.pid) {
      throw new InternalServerErrorException('spawn failed');
    }

    await this.prisma.panelUpdateState.update({
      where: { id: 'current' },
      data: { pid: child.pid },
    });

    // Watcher логов: файл-based, поэтому переживает reload API.
    // Новый API-инстанс при getStatus() видит state.status=running и
    // продолжает читать тот же файл с offset=0 (хвост уже в БД через flushDb).
    this.attachLogWatcher(logFilePath, fromVersion, toVersion, userId, child.pid);

    // detached + unref → процесс полностью отвязан от родителя.
    child.unref();

    this.logger.log(`Update started: pid=${child.pid}, ${fromVersion} → ${toVersion}, by user ${userId}`);
    return { ok: true, pid: child.pid };
  }

  // ---------------------------------------------------------------------------
  // INTERNALS
  // ---------------------------------------------------------------------------

  /**
   * Файл-based watcher логов update.sh.
   *
   * Через polling каждые 500ms читает хвост файла, обновляет logTail и
   * currentStage в БД. Когда update.sh завершается (по pid-проверке),
   * пишет финальный статус и запись в History.
   *
   * Преимущество перед pipe-watcher: переживает pm2 reload meowbox-api,
   * потому что файл существует независимо от процессов API.
   */
  private attachLogWatcher(
    logFilePath: string,
    fromVersion: string,
    toVersion: string,
    userId: string,
    pid: number,
  ): void {
    const startedAt = new Date();
    let logTail = '';
    let currentStage: string | null = 'preflight';
    let offset = 0;
    let finished = false;

    const flushDb = async () => {
      try {
        await this.prisma.panelUpdateState.update({
          where: { id: 'current' },
          data: { logTail: logTail.slice(-16 * 1024), currentStage },
        });
      } catch (e) {
        this.logger.warn(`flushDb: ${(e as Error).message}`);
      }
    };

    const readNew = async (): Promise<void> => {
      try {
        const stat = await fsp.stat(logFilePath);
        if (stat.size <= offset) return;
        const fd = await fsp.open(logFilePath, 'r');
        try {
          const len = stat.size - offset;
          const buf = Buffer.alloc(len);
          await fd.read(buf, 0, len, offset);
          offset = stat.size;
          const text = buf.toString('utf8');
          logTail += text;
          for (const line of text.split('\n')) {
            const m = line.match(/^\[stage:([a-z_-]+)\]/);
            if (m) currentStage = m[1];
          }
        } finally {
          await fd.close();
        }
      } catch {
        /* файл может быть ещё не создан — следующий тик подхватит */
      }
    };

    const finalize = async (status: 'succeeded' | 'failed') => {
      if (finished) return;
      finished = true;
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      // Дочитываем хвост — pm2 reload может оставить последние строки
      // не вычитанными (interval ещё не сработал).
      await readNew();
      try {
        await this.prisma.panelUpdateState.update({
          where: { id: 'current' },
          data: {
            status,
            finishedAt,
            currentStage: status === 'succeeded' ? null : currentStage,
            errorMessage: status === 'failed' ? this.extractErrorFromLog(logTail) : null,
            logTail: logTail.slice(-16 * 1024),
          },
        });
        await this.prisma.panelUpdateHistory.create({
          data: {
            id: cryptoRandomUuid(),
            fromVersion,
            toVersion,
            status,
            startedAt,
            finishedAt,
            durationMs,
            triggeredBy: `user:${userId}`,
            errorMessage: status === 'failed' ? this.extractErrorFromLog(logTail) : null,
          },
        });
      } catch (e) {
        this.logger.error(`finalize: ${(e as Error).message}`);
      }
      this.logger.log(`Update finished: ${status} (${durationMs}ms)`);
    };

    const panelDir = this.getPanelDir();
    const stateDir = process.env.MEOWBOX_STATE_DIR || path.join(panelDir, 'state');
    const sentinelPath = path.join(stateDir, '.update-success');

    const tick = async () => {
      if (finished) return;
      await readNew();
      const alive = this.isProcessAlive(pid);
      if (!alive) {
        // Процесс умер. Успех определяем по sentinel-файлу
        // (update.sh пишет его строкой после "Update OK") — fallback
        // на regex по логу, на случай старых релизов без sentinel'а.
        const okBySentinel = await this.fileExists(sentinelPath);
        const okByLog = /\[update\] ✓ Update OK:/.test(logTail);
        const ok = okBySentinel || okByLog;
        await flushDb();
        await finalize(ok ? 'succeeded' : 'failed');
        if (ok) {
          await fsp.unlink(sentinelPath).catch(() => {});
        }
        return;
      }
      await flushDb();
    };

    // Первый тик быстро (через 500ms), дальше каждые 1500ms.
    setTimeout(() => {
      tick();
      const interval = setInterval(async () => {
        if (finished) {
          clearInterval(interval);
          return;
        }
        await tick();
      }, 1500);
      // Hard timeout: 30 минут. После — считаем зависшим.
      setTimeout(async () => {
        if (!finished) {
          clearInterval(interval);
          this.logger.warn(`Update watcher timeout (pid=${pid}) — finalize as failed`);
          currentStage = currentStage || 'unknown';
          await finalize('failed');
        }
      }, 30 * 60 * 1000).unref();
    }, 500).unref();
  }

  /**
   * Из последних строк лога update.sh достаём первую "✗"-строку (err) или
   * последние ~500 символов как fallback.
   */
  private extractErrorFromLog(logTail: string): string {
    const lines = logTail.split('\n').filter(Boolean);
    const errLine = [...lines].reverse().find((l) => /^\[update\] ✗/.test(l));
    if (errLine) return errLine.replace(/^\[update\] ✗\s*/, '').slice(0, 500);
    return logTail.slice(-500);
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async fileExists(p: string): Promise<boolean> {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  }

  private readCurrentVersion(): string {
    const panelDir = this.getPanelDir();
    const versionFile = path.join(panelDir, 'current', 'VERSION');
    if (fs.existsSync(versionFile)) {
      try {
        return fs.readFileSync(versionFile, 'utf8').trim() || 'unknown';
      } catch { /* fall through */ }
    }
    // Legacy раскладка: VERSION файл в корне панели.
    const legacyVersion = path.join(panelDir, 'VERSION');
    if (fs.existsSync(legacyVersion)) {
      try {
        return fs.readFileSync(legacyVersion, 'utf8').trim() || 'unknown';
      } catch { /* */ }
    }
    return 'unknown';
  }

  /**
   * Список последних релизов из GitHub. Используется в /admin/updates и
   * в массовом обновлении серверов (выбор целевой версии).
   * Кешируется на 5 минут чтобы не упираться в GitHub rate-limit.
   */
  private tagsCache: { tags: Array<{ tag: string; publishedAt: string | null; prerelease: boolean }>; cachedAt: number } | null = null;

  async listReleaseTags(refresh = false): Promise<Array<{ tag: string; publishedAt: string | null; prerelease: boolean }>> {
    const TTL = 5 * 60 * 1000;
    if (!refresh && this.tagsCache && Date.now() - this.tagsCache.cachedAt < TTL) {
      return this.tagsCache.tags;
    }

    const repo = this.config.get<string>('GITHUB_REPO') || 'gvozdb/meowbox';
    const token = this.config.get<string>('GITHUB_TOKEN') || process.env.GITHUB_TOKEN;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'meowbox-panel',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers });
      if (!r.ok) {
        this.logger.warn(`GitHub releases API ${r.status}`);
        return this.tagsCache?.tags ?? [];
      }
      const arr = (await r.json()) as Array<{
        tag_name?: string;
        published_at?: string;
        draft?: boolean;
        prerelease?: boolean;
      }>;
      const tags = arr
        .filter((x) => !x.draft && x.tag_name)
        .map((x) => ({
          tag: x.tag_name as string,
          publishedAt: x.published_at ?? null,
          prerelease: !!x.prerelease,
        }));
      this.tagsCache = { tags, cachedAt: Date.now() };
      return tags;
    } catch (e) {
      this.logger.warn(`listReleaseTags: ${(e as Error).message}`);
      return this.tagsCache?.tags ?? [];
    }
  }

  private async fetchLatestTag(): Promise<string | null> {
    const repo = this.config.get<string>('GITHUB_REPO') || 'gvozdb/meowbox';
    const token = this.config.get<string>('GITHUB_TOKEN') || process.env.GITHUB_TOKEN;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'meowbox-panel',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    try {
      // 1) Пытаемся latest-релиз (требует прав на private repo, если он private).
      let r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
      if (r.ok) {
        const json = (await r.json()) as { tag_name?: string };
        const tag = json.tag_name ?? null;
        this.latestCache = { tag, checkedAt: Date.now() };
        return tag;
      }
      // 2) Fallback на список релизов (latest может быть отсутствующим или draft).
      r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=1`, { headers });
      if (r.ok) {
        const arr = (await r.json()) as Array<{ tag_name?: string; draft?: boolean; prerelease?: boolean }>;
        const tag = arr.find((x) => !x.draft)?.tag_name ?? null;
        this.latestCache = { tag, checkedAt: Date.now() };
        return tag;
      }
      this.logger.warn(`GitHub API ${r.status}${token ? '' : ' (no GITHUB_TOKEN — приватные репо вернут 404)'}`);
      return this.latestCache?.tag ?? null;
    } catch (e) {
      this.logger.warn(`fetchLatestTag: ${(e as Error).message}`);
      return this.latestCache?.tag ?? null;
    }
  }

  private getPanelDir(): string {
    return this.config.get<string>('MEOWBOX_PANEL_DIR') || '/opt/meowbox';
  }
}

function cryptoRandomUuid(): string {
  // Чтобы не тащить зависимость на uuid — встроенный crypto.
  const c = require('node:crypto') as typeof import('node:crypto');
  return c.randomUUID();
}
