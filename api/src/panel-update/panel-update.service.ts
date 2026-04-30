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
import * as path from 'node:path';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
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
export class PanelUpdateService {
  private readonly logger = new Logger(PanelUpdateService.name);
  private latestCache: { tag: string | null; checkedAt: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

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

    // Если status=running, но pid мёртв — корректируем на failed.
    if (state.status === 'running' && state.pid && !this.isProcessAlive(state.pid)) {
      state = await this.prisma.panelUpdateState.update({
        where: { id: 'current' },
        data: {
          status: 'failed',
          errorMessage: 'update.sh died unexpectedly (pid not found)',
          finishedAt: new Date(),
        },
      });
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

    const args: string[] = [updateScript];
    if (targetVersion) args.push(targetVersion);
    args.push(`--triggered-by=user:${userId}`);

    const child = spawn('bash', args, {
      cwd: panelDir,
      env: { ...process.env, MEOWBOX_TRIGGERED_BY: `user:${userId}` },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    if (!child.pid) {
      throw new InternalServerErrorException('spawn failed');
    }

    await this.prisma.panelUpdateState.update({
      where: { id: 'current' },
      data: { pid: child.pid },
    });

    this.attachStreams(child, fromVersion, toVersion, userId);

    // detached + unref → процесс выживает рестарт API (если в ходе update случится pm2 reload).
    child.unref();

    this.logger.log(`Update started: pid=${child.pid}, ${fromVersion} → ${toVersion}, by user ${userId}`);
    return { ok: true, pid: child.pid };
  }

  // ---------------------------------------------------------------------------
  // INTERNALS
  // ---------------------------------------------------------------------------

  private attachStreams(
    child: ReturnType<typeof spawn>,
    fromVersion: string,
    toVersion: string,
    userId: string,
  ): void {
    const startedAt = new Date();
    let logTail = '';
    let currentStage: string | null = 'preflight';

    const flushDb = (() => {
      let pending: NodeJS.Timeout | null = null;
      let dirty = false;
      return () => {
        dirty = true;
        if (pending) return;
        pending = setTimeout(async () => {
          pending = null;
          if (!dirty) return;
          dirty = false;
          try {
            await this.prisma.panelUpdateState.update({
              where: { id: 'current' },
              data: { logTail: logTail.slice(-16 * 1024), currentStage },
            });
          } catch (e) {
            this.logger.warn(`flushDb: ${(e as Error).message}`);
          }
        }, 500);
      };
    })();

    const onChunk = (buf: Buffer) => {
      const text = buf.toString('utf8');
      logTail += text;
      // Парсим [stage:NAME] из любой строки чанка
      for (const line of text.split('\n')) {
        const m = line.match(/^\[stage:([a-z_-]+)\]/);
        if (m) currentStage = m[1];
      }
      flushDb();
    };

    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    child.on('exit', async (code) => {
      const finishedAt = new Date();
      const status = code === 0 ? 'succeeded' : 'failed';
      const durationMs = finishedAt.getTime() - startedAt.getTime();

      try {
        await this.prisma.panelUpdateState.update({
          where: { id: 'current' },
          data: {
            status,
            finishedAt,
            currentStage: status === 'succeeded' ? null : currentStage,
            errorMessage: status === 'failed' ? `Exit code ${code}` : null,
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
            errorMessage: status === 'failed' ? `Exit code ${code}` : null,
          },
        });
      } catch (e) {
        this.logger.error(`exit handler: ${(e as Error).message}`);
      }
      this.logger.log(`Update finished: ${status} (code=${code}, ${durationMs}ms)`);
    });
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
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
