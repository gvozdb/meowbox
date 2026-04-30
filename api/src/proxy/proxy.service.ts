import {
  Injectable,
  Logger,
  OnModuleInit,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { readFile, writeFile, rename, mkdir, chmod } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { assertPublicHttpUrl } from '../common/validators/safe-url';

export interface ServerConfig {
  id: string;
  name: string;
  url: string; // e.g. "http://10.0.0.5:3000"
  token: string; // proxy auth token
}

export interface ServerInfo extends ServerConfig {
  online: boolean;
  /** Текущая версия панели на удалённом сервере (например `v0.3.0`). */
  version?: string;
  /** Latest release с GitHub, как видит сам удалённый сервер (может быть null если приватный repo и нет токена). */
  latestVersion?: string | null;
  /** Доступно ли обновление (latest > current на удалённом). */
  hasUpdate?: boolean;
  /** Последняя успешная проверка статуса (ISO). */
  lastCheckedAt?: string;
  /** Если последняя проверка упала — причина. */
  lastError?: string;
}

const DATA_DIR = join(process.cwd(), '..', 'data');
const SERVERS_FILE = join(DATA_DIR, 'servers.json');

@Injectable()
export class ProxyService implements OnModuleInit {
  private readonly logger = new Logger('ProxyService');
  private servers: ServerConfig[] = [];

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    await this.loadServers();
  }

  private async loadServers() {
    // Ensure data directory exists
    if (!existsSync(DATA_DIR)) {
      await mkdir(DATA_DIR, { recursive: true });
    }

    // Try to read from JSON file
    if (existsSync(SERVERS_FILE)) {
      try {
        const raw = await readFile(SERVERS_FILE, 'utf-8');
        this.servers = JSON.parse(raw);
        this.logger.log(
          `Loaded ${this.servers.length} server(s) from ${SERVERS_FILE}`,
        );
        return;
      } catch {
        this.logger.warn('Failed to parse servers.json, checking env fallback');
      }
    }

    // Fallback: migrate from SERVERS env var
    const envRaw = this.config.get<string>('SERVERS', '');
    if (envRaw) {
      try {
        this.servers = JSON.parse(envRaw);
        this.logger.log(
          `Migrated ${this.servers.length} server(s) from SERVERS env to JSON`,
        );
        await this.saveServers();
        return;
      } catch {
        this.logger.warn('Failed to parse SERVERS env');
      }
    }

    // No servers configured — create empty file
    this.servers = [];
    await this.saveServers();
    this.logger.log('Created empty servers.json');
  }

  private async saveServers() {
    // Atomic write: tmp file → rename. chmod 600 ОБЯЗАТЕЛЬНО — файл содержит
    // PROXY_TOKEN'ы всех slave-серверов в plaintext. Любой локальный юзер не
    // должен мочь их прочитать.
    const tmp = SERVERS_FILE + '.tmp';
    await writeFile(tmp, JSON.stringify(this.servers, null, 2), 'utf-8');
    await chmod(tmp, 0o600);
    await rename(tmp, SERVERS_FILE);
  }

  getServers(): ServerConfig[] {
    return this.servers;
  }

  getServer(id: string): ServerConfig | undefined {
    return this.servers.find((s) => s.id === id);
  }

  async addServer(
    data: Omit<ServerConfig, 'id'> & { id?: string },
  ): Promise<ServerConfig> {
    if (this.servers.some((s) => s.name === data.name)) {
      throw new BadRequestException(`Server "${data.name}" already exists`);
    }

    // Runtime-проверка URL: блокируем 127.0.0.1 / AWS IMDS / private-net.
    // proxy-фичу легко превратить в SSRF-гаджет (forward-any-request),
    // поэтому DNS-lookup + RFC1918-фильтр обязательны. Сам протокол —
    // http или https: PROXY_TOKEN (HMAC) обеспечивает аутентификацию,
    // TLS — рекомендация, но не requirement (slave может стоять на raw IP).
    await assertPublicHttpUrl(data.url, { protocols: ['http:', 'https:'] });

    const server: ServerConfig = {
      id: data.id || randomUUID().slice(0, 8),
      name: data.name,
      url: data.url.replace(/\/+$/, ''), // strip trailing slash
      token: data.token,
    };

    this.servers.push(server);
    await this.saveServers();
    this.logger.log(`Added server "${server.name}" (${server.id})`);
    return server;
  }

  async updateServer(
    id: string,
    data: Partial<Omit<ServerConfig, 'id'>>,
  ): Promise<ServerConfig> {
    const idx = this.servers.findIndex((s) => s.id === id);
    if (idx === -1) {
      throw new NotFoundException(`Server "${id}" not found`);
    }

    if (data.url !== undefined) {
      // Allow http для только что провижнящихся серверов (до выпуска TLS).
      // Поверх — DTO контроллера уже требует https для добавления вручную,
      // так что http-путь остаётся только внутреннему provision.
      await assertPublicHttpUrl(data.url, { protocols: ['http:', 'https:'] });
    }

    if (data.name !== undefined) this.servers[idx].name = data.name;
    if (data.url !== undefined)
      this.servers[idx].url = data.url.replace(/\/+$/, '');
    if (data.token !== undefined) this.servers[idx].token = data.token;

    await this.saveServers();
    // URL/токен поменялись — статус мог стать невалидным. Инвалидируем кеш.
    this.statusCache.delete(id);
    this.logger.log(`Updated server "${this.servers[idx].name}" (${id})`);
    return this.servers[idx];
  }

  async removeServer(id: string): Promise<void> {
    const idx = this.servers.findIndex((s) => s.id === id);
    if (idx === -1) {
      throw new NotFoundException(`Server "${id}" not found`);
    }

    const name = this.servers[idx].name;
    this.servers.splice(idx, 1);
    await this.saveServers();
    this.statusCache.delete(id);
    this.logger.log(`Removed server "${name}" (${id})`);
  }

  /**
   * Endpoint-классы с увеличенным таймаутом — длинные операции, которые
   * не дотянут за 30 секунд. Совпадение по startsWith.
   */
  private static readonly LONG_RUNNING_PATHS = [
    '/backups/',           // start/restore — могут идти минуты
    '/migration/',         // импорт/экспорт сайтов
    '/sites/clone',
    '/admin/update',       // panel-update (запускает spawn в фоне, но всё-таки)
    '/system/updates/install',
    '/system/updates/upgrade-all',
    '/system/self-update',
    '/database/import',
    '/database/dump',
  ];

  /** Таймаут в мс на основе path (smart-timeout). */
  private getTimeoutMs(path: string): number {
    const isLong = ProxyService.LONG_RUNNING_PATHS.some((p) => path.startsWith(p));
    return isLong ? 600_000 : 30_000;
  }

  /**
   * Proxy an HTTP request to a remote server.
   * @param timeoutOverride — явный таймаут в мс (если не задан, выбирается smart по path)
   */
  async proxyRequest(
    server: ServerConfig,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    timeoutOverride?: number,
  ): Promise<{ status: number; data: unknown }> {
    const url = `${server.url}/api${path}`;

    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Proxy-Token': server.token,
      ...headers,
    };

    // Remove auth headers that belong to the main server
    delete reqHeaders['authorization'];
    delete reqHeaders['Authorization'];

    const timeoutMs = timeoutOverride ?? this.getTimeoutMs(path);

    const fetchOptions: RequestInit = {
      method,
      headers: reqHeaders,
      signal: AbortSignal.timeout(timeoutMs),
    };

    if (body && method !== 'GET' && method !== 'HEAD') {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);
    const data = await response.json().catch(() => null);

    return { status: response.status, data };
  }

  /**
   * Ping a server to check if it's online + get version.
   * Использует /admin/update/version — лёгкий endpoint, который возвращает
   * current/latest/hasUpdate (читает VERSION файл и кешированный latest).
   */
  async pingServer(
    server: ServerConfig,
  ): Promise<{
    online: boolean;
    version?: string;
    latestVersion?: string | null;
    hasUpdate?: boolean;
    lastError?: string;
  }> {
    try {
      const { status, data } = await this.proxyRequest(
        server,
        'GET',
        '/admin/update/version',
        undefined,
        undefined,
        5_000, // ping должен быть быстрым
      );
      if (status === 200 && data) {
        const payload = (data as { data?: { current?: string; latest?: string | null; hasUpdate?: boolean } }).data;
        return {
          online: true,
          version: payload?.current,
          latestVersion: payload?.latest ?? null,
          hasUpdate: !!payload?.hasUpdate,
        };
      }
      return { online: false, lastError: `HTTP ${status}` };
    } catch (err) {
      return { online: false, lastError: (err as Error).message };
    }
  }

  /**
   * In-memory кеш статуса серверов. Обновляется фоновым healthcheck'ом
   * (см. ProxyHealthcheckService) и при ручных кликах "Обновить".
   * Карта по serverId.
   */
  private statusCache = new Map<string, Omit<ServerInfo, keyof ServerConfig>>();

  /**
   * Прокладка для healthcheck/ручного refresh.
   * Пингует все серверы параллельно, обновляет statusCache, возвращает результат.
   */
  async refreshStatuses(): Promise<ServerInfo[]> {
    const results = await Promise.allSettled(
      this.servers.map(async (s) => {
        const ping = await this.pingServer(s);
        const status = {
          online: ping.online,
          version: ping.version,
          latestVersion: ping.latestVersion,
          hasUpdate: ping.hasUpdate,
          lastError: ping.lastError,
          lastCheckedAt: new Date().toISOString(),
        };
        this.statusCache.set(s.id, status);
        return { ...s, ...status, token: '***' } as ServerInfo;
      }),
    );

    return results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const fallback = {
        online: false,
        lastError: (r.reason as Error)?.message ?? 'unknown',
        lastCheckedAt: new Date().toISOString(),
      };
      this.statusCache.set(this.servers[i].id, fallback);
      return { ...this.servers[i], ...fallback, token: '***' } as ServerInfo;
    });
  }

  /**
   * Возвращает текущий снапшот серверов из кеша. Если кеш пуст для какого-то
   * сервера — пингует его. Используется в /api/servers (быстрый ответ).
   */
  async getServersWithStatus(): Promise<ServerInfo[]> {
    const missing = this.servers.filter((s) => !this.statusCache.has(s.id));
    if (missing.length > 0) {
      // Пингуем только те, что отсутствуют в кеше — фоновая задача наполнит
      // остальные. Это снимает load с /api/servers при добавлении нового сервера.
      await Promise.allSettled(
        missing.map(async (s) => {
          const ping = await this.pingServer(s);
          this.statusCache.set(s.id, {
            online: ping.online,
            version: ping.version,
            latestVersion: ping.latestVersion,
            hasUpdate: ping.hasUpdate,
            lastError: ping.lastError,
            lastCheckedAt: new Date().toISOString(),
          });
        }),
      );
    }

    return this.servers.map((s) => {
      const status = this.statusCache.get(s.id) ?? { online: false };
      return { ...s, ...status, token: '***' } as ServerInfo;
    });
  }

  /** Очищает кеш статуса конкретного сервера (после edit/remove). */
  invalidateStatus(serverId: string): void {
    this.statusCache.delete(serverId);
  }
}
